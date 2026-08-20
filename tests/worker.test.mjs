import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import worker from "../src/index.ts";
import { checkRateLimit, resetRateLimit } from "../src/rate-limit.ts";
import {
    appendLeadRow,
    COLUMNS,
    columnLetter,
    pemToPkcs8,
    quoteSheetName,
    resetTokenCache,
} from "../src/sheets.ts";
import { parseSubmission } from "../src/fields.ts";

const ENV = { ALLOWED_ORIGINS: "https://invaritech.ai" };

describe("router", () => {
    it("serves a health check at the root", async () => {
        const response = await worker.fetch(new Request("https://api.invaritech.ai/"), ENV);

        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, "ok");
    });

    it("returns JSON 404 for unknown paths", async () => {
        const response = await worker.fetch(new Request("https://api.invaritech.ai/nope"), ENV);

        assert.equal(response.status, 404);
        assert.equal(response.headers.get("content-type"), "application/json");
        assert.deepEqual(await response.json(), { success: false, error: "Not found" });
    });

    it("returns JSON 405 with an Allow header for the wrong method", async () => {
        const response = await worker.fetch(
            new Request("https://api.invaritech.ai/v1/contact", { method: "GET" }),
            ENV,
        );

        assert.equal(response.status, 405);
        assert.equal(response.headers.get("allow"), "POST, OPTIONS");
        assert.equal((await response.json()).success, false);
    });

    it("routes preflight to the CORS handler", async () => {
        const response = await worker.fetch(
            new Request("https://api.invaritech.ai/v1/contact", {
                method: "OPTIONS",
                headers: { origin: "https://invaritech.ai" },
            }),
            ENV,
        );

        assert.equal(response.status, 204);
        assert.equal(
            response.headers.get("access-control-allow-origin"),
            "https://invaritech.ai",
        );
    });
});

describe("rate limiting", () => {
    beforeEach(() => resetRateLimit());

    it("defers to the Cloudflare binding when one is bound", async () => {
        const seen = [];
        const env = {
            RATE_LIMITER: {
                limit: async ({ key }) => {
                    seen.push(key);
                    return { success: false };
                },
            },
        };

        assert.equal(await checkRateLimit(env, "203.0.113.7"), false);
        assert.deepEqual(seen, ["203.0.113.7"]);
    });

    it("falls back to an in-memory window when no binding is bound", async () => {
        const now = Date.now();

        for (let i = 0; i < 5; i += 1) {
            assert.equal(await checkRateLimit({}, "203.0.113.7", now), true);
        }
        assert.equal(await checkRateLimit({}, "203.0.113.7", now), false);
    });

    it("keys the fallback window per client", async () => {
        const now = Date.now();
        for (let i = 0; i < 5; i += 1) await checkRateLimit({}, "203.0.113.7", now);

        assert.equal(await checkRateLimit({}, "198.51.100.4", now), true);
    });

    it("lets the fallback window expire", async () => {
        const now = Date.now();
        for (let i = 0; i < 5; i += 1) await checkRateLimit({}, "203.0.113.7", now);

        assert.equal(await checkRateLimit({}, "203.0.113.7", now + 61_000), true);
    });
});

describe("google service-account auth", () => {
    const realFetch = globalThis.fetch;
    let privateKeyPem;
    let requests;

    async function generatePem() {
        const pair = await crypto.subtle.generateKey(
            {
                name: "RSASSA-PKCS1-v1_5",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256",
            },
            true,
            ["sign", "verify"],
        );
        const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
        const base64 = Buffer.from(pkcs8).toString("base64");
        const lines = base64.match(/.{1,64}/g).join("\n");
        return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
    }

    function submission() {
        const fd = new FormData();
        fd.set("name", "Ada Lovelace");
        fd.set("email", "ada@example.com");
        fd.set("country", "United Kingdom");
        fd.set("message", "Hello");
        fd.set("cf_turnstile_token", "token");
        const parsed = parseSubmission(fd);
        assert.equal(parsed.ok, true);
        return parsed.submission;
    }

    function env() {
        return {
            GOOGLE_SHEETS_CLIENT_EMAIL: "svc@project.iam.gserviceaccount.com",
            GOOGLE_SHEETS_PRIVATE_KEY: privateKeyPem,
            LEADS_SPREADSHEET_ID: "sheet-123",
            LEADS_SHEET_NAME: "Sheet1",
        };
    }

    beforeEach(async () => {
        resetTokenCache();
        requests = [];
        privateKeyPem = privateKeyPem ?? (await generatePem());
        globalThis.fetch = async (url, init) => {
            requests.push({ url: String(url), init });
            if (String(url).includes("oauth2.googleapis.com")) {
                return new Response(
                    JSON.stringify({ access_token: "token-abc", expires_in: 3600 }),
                    { status: 200, headers: { "Content-Type": "application/json" } },
                );
            }
            return new Response(JSON.stringify({}), { status: 200 });
        };
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("signs a JWT, exchanges it, and appends the row", async () => {
        await appendLeadRow(env(), submission(), { status: "verified", hostname: "invaritech.ai" });

        assert.equal(requests.length, 2);

        const assertion = new URLSearchParams(requests[0].init.body).get("assertion");
        const [header, claims, signature] = assertion.split(".");
        assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
            alg: "RS256",
            typ: "JWT",
        });
        const decodedClaims = JSON.parse(Buffer.from(claims, "base64url").toString());
        assert.equal(decodedClaims.iss, "svc@project.iam.gserviceaccount.com");
        assert.equal(decodedClaims.scope, "https://www.googleapis.com/auth/spreadsheets");
        assert.ok(signature.length > 0);

        assert.ok(requests[1].url.startsWith("https://sheets.googleapis.com/v4/spreadsheets/sheet-123"));
        assert.ok(requests[1].url.includes("valueInputOption=RAW"));
        assert.equal(requests[1].init.headers.Authorization, "Bearer token-abc");
        assert.equal(JSON.parse(requests[1].init.body).values[0].length, COLUMNS.length);
    });

    it("writes with RAW so Sheets stores values unparsed", async () => {
        // This is the formula-injection and numeric-coercion control.
        await appendLeadRow(env(), submission(), { status: "verified", hostname: "" });

        assert.ok(requests[1].url.includes("valueInputOption=RAW"));
        assert.ok(!requests[1].url.includes("USER_ENTERED"));
    });

    it("bounds both upstream calls with an abort signal", async () => {
        await appendLeadRow(env(), submission(), { status: "verified", hostname: "" });

        for (const call of requests) {
            assert.ok(call.init.signal instanceof AbortSignal);
        }
    });

    it("targets the full column range", async () => {
        await appendLeadRow(env(), submission(), { status: "verified", hostname: "" });

        assert.ok(
            requests[1].url.includes(
                encodeURIComponent(`'Sheet1'!A:${columnLetter(COLUMNS.length)}`),
            ),
        );
    });

    it("quotes a sheet name containing a space", async () => {
        await appendLeadRow(
            { ...env(), LEADS_SHEET_NAME: "Contact Leads" },
            submission(),
            { status: "verified", hostname: "" },
        );

        assert.ok(requests[1].url.includes(encodeURIComponent("'Contact Leads'!A:")));
    });

    it("escapes an apostrophe in the sheet name", async () => {
        await appendLeadRow(
            { ...env(), LEADS_SHEET_NAME: "O'Brien" },
            submission(),
            { status: "verified", hostname: "" },
        );

        assert.ok(requests[1].url.includes(encodeURIComponent("'O''Brien'!A:")));
    });

    it("reuses the cached access token across submissions", async () => {
        const verified = { status: "verified", hostname: "invaritech.ai" };
        await appendLeadRow(env(), submission(), verified);
        await appendLeadRow(env(), submission(), verified);

        const tokenRequests = requests.filter((r) => r.url.includes("oauth2.googleapis.com"));
        assert.equal(tokenRequests.length, 1);
    });

    it("throws without leaking the response body when the append fails", async () => {
        globalThis.fetch = async (url) => {
            if (String(url).includes("oauth2.googleapis.com")) {
                return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), {
                    status: 200,
                });
            }
            return new Response("Requested entity was not found: spreadsheet sheet-123", {
                status: 404,
            });
        };

        await assert.rejects(
            () => appendLeadRow(env(), submission(), { status: "verified", hostname: "" }),
            (error) => {
                assert.equal(error.message, "Sheets append responded with 404");
                return true;
            },
        );
    });

    it("throws when configuration is missing", async () => {
        await assert.rejects(
            () => appendLeadRow({}, submission(), { status: "verified", hostname: "" }),
            /configuration missing/,
        );
    });

    it("decodes a PEM key with literal escaped newlines", () => {
        const escaped = privateKeyPem.replace(/\n/g, "\\n");

        assert.deepEqual(
            new Uint8Array(pemToPkcs8(escaped)),
            new Uint8Array(pemToPkcs8(privateKeyPem)),
        );
    });
});

describe("column letters", () => {
    it("maps 1-based indexes onto A1 notation", () => {
        assert.equal(columnLetter(1), "A");
        assert.equal(columnLetter(26), "Z");
        assert.equal(columnLetter(27), "AA");
        assert.equal(columnLetter(35), "AI");
    });

    it("covers every column the sheet writes", () => {
        assert.equal(columnLetter(COLUMNS.length), "AI");
    });
});

describe("sheet name quoting", () => {
    it("always quotes, so a plain name is still valid A1", () => {
        assert.equal(quoteSheetName("Sheet1"), "'Sheet1'");
    });

    it("quotes names that would otherwise be ambiguous", () => {
        assert.equal(quoteSheetName("Contact Leads"), "'Contact Leads'");
        assert.equal(quoteSheetName("Q1"), "'Q1'");
    });

    it("doubles embedded apostrophes", () => {
        assert.equal(quoteSheetName("O'Brien"), "'O''Brien'");
        assert.equal(quoteSheetName("a'b'c"), "'a''b''c'");
    });
});
