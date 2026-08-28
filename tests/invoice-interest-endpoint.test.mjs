import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { handleInvoiceInterest } from "../src/handle-contact.ts";

const ORIGIN = "https://invaritech-website-next.pages.dev";
const URL = "https://contact-api.invaritech.ai/v1/invoice-interest";
const ENV = { ALLOWED_ORIGINS: ORIGIN };

function form(overrides = {}) {
    const data = new FormData();
    const fields = {
        email: "finance@example.com",
        interest: "invoice_pipeline",
        cf_turnstile_token: "token-value",
        utm_source: "invoice-extractor",
        ...overrides,
    };
    for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) data.set(key, value);
    }
    return data;
}

function request(data) {
    return new Request(URL, {
        method: "POST",
        body: data,
        headers: {
            origin: ORIGIN,
            "cf-connecting-ip": "203.0.113.7",
            "cf-ipcountry": "HK",
        },
    });
}

let calls;

function deps() {
    return {
        verifyTurnstile: async (_env, token, ip) => {
            calls.turnstile.push({ token, ip });
            return { status: "verified", hostname: "invaritech.ai" };
        },
        appendLeadRow: async (_env, submission) => calls.appended.push(submission),
        sendNotification: async (_env, submission) => calls.emailed.push(submission),
        checkRateLimit: async () => true,
    };
}

beforeEach(() => {
    calls = { turnstile: [], appended: [], emailed: [] };
});

describe("invoice interest submissions", () => {
    it("records an email-only pipeline lead in the existing contact pipeline", async () => {
        const data = form({
            message: "Attacker-controlled text must not enter the lead",
            batch_id: "private-bearer-identifier",
        });
        const response = await handleInvoiceInterest(request(data), ENV, deps());

        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), { success: true });
        assert.equal(calls.appended.length, 1);
        assert.equal(calls.emailed.length, 1);
        assert.deepEqual(calls.turnstile, [{ token: "token-value", ip: "203.0.113.7" }]);

        const submission = calls.appended[0];
        assert.equal(submission.formType, "invoice_interest");
        assert.equal(submission.source, "invoice_pipeline");
        assert.equal(submission.email, "finance@example.com");
        assert.equal(submission.country, "HK");
        assert.equal(submission.company, "");
        assert.equal(submission.phone, "");
        assert.equal(
            submission.message,
            "Interested in invoice intake from email and approved posting to accounting software such as Xero.",
        );
        assert.ok(!JSON.stringify(submission).includes("Attacker-controlled"));
        assert.ok(!JSON.stringify(submission).includes("private-bearer"));
    });

    it("records the future matching workflow as a distinct intent", async () => {
        const response = await handleInvoiceInterest(
            request(form({ interest: "three_way_matching" })),
            ENV,
            deps(),
        );

        assert.equal(response.status, 201);
        assert.equal(calls.appended[0].source, "three_way_matching");
        assert.match(calls.appended[0].message, /account-required matching/);
    });

    for (const [label, overrides, error] of [
        ["missing email", { email: undefined }, "Email is required"],
        ["invalid email", { email: "invalid" }, "Please enter a valid email address"],
        ["missing interest", { interest: undefined }, "Please choose an interest"],
        ["unknown interest", { interest: "__proto__" }, "Please choose an interest"],
        [
            "missing verification",
            { cf_turnstile_token: undefined },
            "Please complete the verification",
        ],
    ]) {
        it(`rejects ${label}`, async () => {
            const response = await handleInvoiceInterest(request(form(overrides)), ENV, deps());

            assert.equal(response.status, 422);
            assert.deepEqual(await response.json(), { success: false, error });
            assert.equal(calls.turnstile.length, 0);
            assert.equal(calls.appended.length, 0);
        });
    }
});
