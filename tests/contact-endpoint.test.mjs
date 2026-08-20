import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

process.env.ALLOWED_ORIGINS = "https://invaritech.ai,https://www.invaritech.ai";

const { handleContact, handlePreflight } = await import("../lib/handle-contact.ts");

const ORIGIN = "https://invaritech.ai";
const URL_UNDER_TEST = "https://api.invaritech.ai/v1/contact";

function validForm(overrides = {}) {
    const fd = new FormData();
    const fields = {
        name: "Ada Lovelace",
        email: "ada@example.com",
        country: "United Kingdom",
        message: "Please get in touch about invoice automation.",
        cf_turnstile_token: "token-value",
        utm_source: "google",
        ...overrides,
    };
    for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) fd.set(key, value);
    }
    return fd;
}

function request(form, { origin = ORIGIN } = {}) {
    const headers = origin ? { origin } : {};
    return new Request(URL_UNDER_TEST, { method: "POST", body: form, headers });
}

let calls;

function deps(overrides = {}) {
    return {
        verifyTurnstile: async () => {
            calls.turnstile += 1;
            return { status: "verified", hostname: "invaritech.ai" };
        },
        appendLeadRow: async (submission) => {
            calls.appended.push(submission);
        },
        sendNotification: async (submission) => {
            calls.emailed.push(submission);
        },
        checkRateLimit: () => true,
        ...overrides,
    };
}

beforeEach(() => {
    calls = { turnstile: 0, appended: [], emailed: [] };
});

describe("successful submission", () => {
    it("returns 201 with a JSON success envelope", async () => {
        const response = await handleContact(request(validForm()), deps());

        assert.equal(response.status, 201);
        assert.equal(response.headers.get("content-type"), "application/json");
        assert.deepEqual(await response.json(), { success: true });
    });

    it("writes to the spreadsheet and sends the notification", async () => {
        await handleContact(request(validForm()), deps());

        assert.equal(calls.appended.length, 1);
        assert.equal(calls.emailed.length, 1);
        assert.equal(calls.appended[0].name, "Ada Lovelace");
        assert.equal(calls.appended[0].attribution.utm_source, "google");
    });

    it("trims whitespace and defaults absent optional fields to empty strings", async () => {
        await handleContact(request(validForm({ name: "  Ada  " })), deps());

        assert.equal(calls.appended[0].name, "Ada");
        assert.equal(calls.appended[0].company, "");
        assert.equal(calls.appended[0].phone, "");
        assert.equal(calls.appended[0].attribution.gclid, "");
    });
});

describe("validation", () => {
    const cases = [
        ["missing name", { name: undefined }, "Name is required"],
        ["missing email", { email: undefined }, "Email is required"],
        ["malformed email", { email: "not-an-email" }, "Please enter a valid email address"],
        ["missing country", { country: undefined }, "Country is required"],
        ["missing message", { message: undefined }, "Message is required"],
        ["missing token", { cf_turnstile_token: undefined }, "Please complete the verification"],
        ["whitespace-only name", { name: "   " }, "Name is required"],
    ];

    for (const [label, overrides, expected] of cases) {
        it(`rejects ${label} with 422`, async () => {
            const response = await handleContact(request(validForm(overrides)), deps());

            assert.equal(response.status, 422);
            assert.deepEqual(await response.json(), { success: false, error: expected });
            assert.equal(calls.appended.length, 0);
            assert.equal(calls.emailed.length, 0);
        });
    }

    it("does not verify or store anything when validation fails", async () => {
        await handleContact(request(validForm({ email: "bad" })), deps());

        assert.equal(calls.turnstile, 0);
    });

    it("rejects a malformed body with 400", async () => {
        const malformed = new Request(URL_UNDER_TEST, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "multipart/form-data; boundary=nope" },
            body: "not multipart",
        });

        const response = await handleContact(malformed, deps());

        assert.equal(response.status, 400);
        assert.equal((await response.json()).success, false);
    });

    it("rejects an oversized body with 413", async () => {
        const oversized = new Request(URL_UNDER_TEST, {
            method: "POST",
            headers: {
                origin: ORIGIN,
                "content-length": "5000000",
                "content-type": "multipart/form-data; boundary=x",
            },
            body: "x",
        });

        const response = await handleContact(oversized, deps());

        assert.equal(response.status, 413);
        assert.equal((await response.json()).success, false);
    });
});

describe("turnstile", () => {
    it("returns 422 when verification fails", async () => {
        const response = await handleContact(
            request(validForm()),
            deps({ verifyTurnstile: async () => ({ status: "failed", hostname: "" }) }),
        );

        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), {
            success: false,
            error: "Verification failed. Please try again.",
        });
        assert.equal(calls.appended.length, 0);
    });

    it("returns 503 when siteverify is unreachable or unconfigured", async () => {
        const response = await handleContact(
            request(validForm()),
            deps({ verifyTurnstile: async () => ({ status: "unavailable", hostname: "" }) }),
        );

        assert.equal(response.status, 503);
        assert.equal((await response.json()).error, "Unable to send your message. Please try again.");
        assert.equal(calls.appended.length, 0);
    });
});

describe("provider failures", () => {
    it("returns 503 and does not email when the spreadsheet append fails", async () => {
        const response = await handleContact(
            request(validForm()),
            deps({
                appendLeadRow: async () => {
                    throw new Error("Requested entity was not found: spreadsheet 1a2b3c");
                },
            }),
        );

        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
            success: false,
            error: "Unable to send your message. Please try again.",
        });
        assert.equal(calls.emailed.length, 0);
    });

    it("does not leak provider detail in the spreadsheet failure response", async () => {
        const response = await handleContact(
            request(validForm()),
            deps({
                appendLeadRow: async () => {
                    throw new Error("spreadsheet 1a2b3c denied for svc@project.iam");
                },
            }),
        );

        const body = await response.text();
        assert.ok(!body.includes("1a2b3c"));
        assert.ok(!body.includes("iam"));
    });

    it("still returns 201 when the notification email fails", async () => {
        const response = await handleContact(
            request(validForm()),
            deps({
                sendNotification: async () => {
                    throw new Error("Resend responded with 422");
                },
            }),
        );

        // The lead is already in the sheet; a 5xx here would invite a duplicate.
        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), { success: true });
        assert.equal(calls.appended.length, 1);
    });

    it("returns 500 JSON on an unexpected failure", async () => {
        const response = await handleContact(
            request(validForm()),
            deps({
                checkRateLimit: () => {
                    throw new Error("boom");
                },
            }),
        );

        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), {
            success: false,
            error: "Unable to send your message. Please try again.",
        });
    });
});

describe("rate limiting", () => {
    it("returns 429 with the documented message", async () => {
        const response = await handleContact(
            request(validForm()),
            deps({ checkRateLimit: () => false }),
        );

        assert.equal(response.status, 429);
        assert.deepEqual(await response.json(), {
            success: false,
            error: "Too many requests. Please try again later.",
        });
        assert.equal(calls.appended.length, 0);
    });
});

describe("CORS", () => {
    it("echoes an allowed origin on success", async () => {
        const response = await handleContact(request(validForm()), deps());

        assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
        assert.equal(response.headers.get("vary"), "Origin");
    });

    it("rejects a disallowed origin with 403 and no allow header", async () => {
        const response = await handleContact(
            request(validForm(), { origin: "https://attacker.example" }),
            deps(),
        );

        assert.equal(response.status, 403);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        assert.equal(calls.appended.length, 0);
    });

    it("allows requests with no Origin header, such as curl", async () => {
        const response = await handleContact(request(validForm(), { origin: null }), deps());

        assert.equal(response.status, 201);
    });

    it("answers preflight from an allowed origin with 204", () => {
        const response = handlePreflight(
            new Request(URL_UNDER_TEST, { method: "OPTIONS", headers: { origin: ORIGIN } }),
        );

        assert.equal(response.status, 204);
        assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
        assert.equal(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");
    });

    it("refuses preflight from a disallowed origin", async () => {
        const response = handlePreflight(
            new Request(URL_UNDER_TEST, {
                method: "OPTIONS",
                headers: { origin: "https://attacker.example" },
            }),
        );

        assert.equal(response.status, 403);
        assert.equal((await response.json()).success, false);
    });
});
