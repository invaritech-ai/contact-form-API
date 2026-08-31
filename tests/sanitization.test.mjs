import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRow, COLUMNS } from "../src/sheets.ts";
import { buildEmailHtml, escapeHtml, shortClientRef } from "../src/email.ts";
import { clean, parseInvoiceInterest, parseSubmission } from "../src/fields.ts";

const turnstile = { status: "verified", hostname: "invaritech.ai" };

function submission(overrides = {}) {
    const fd = new FormData();
    const fields = {
        name: "Ada Lovelace",
        email: "ada@example.com",
        country: "United Kingdom",
        message: "Hello",
        cf_turnstile_token: "token",
        ...overrides,
    };
    for (const [key, value] of Object.entries(fields)) fd.set(key, value);
    const parsed = parseSubmission(fd);
    assert.equal(parsed.ok, true);
    return parsed.submission;
}

describe("spreadsheet formula injection", () => {
    // Protection comes from valueInputOption=RAW, which stores values unparsed,
    // rather than from escaping. tests/worker.test.mjs pins that option.
    for (const prefix of ["=", "+", "-", "@"]) {
        it(`writes a value beginning with ${prefix} verbatim`, () => {
            const payload = `${prefix}HYPERLINK("x")`;
            const row = buildRow(
                submission({ name: payload }),
                turnstile,
                "2026-01-01T00:00:00.000Z",
            );

            assert.equal(row[COLUMNS.indexOf("name")], payload);
        });
    }
});

describe("numeric-looking values", () => {
    const cases = [
        ["a phone number with a leading zero", "phone", "02079460000"],
        ["an international phone number", "phone", "+44 20 7946 0000"],
        ["a scientific-notation-shaped id", "utm_id", "1E5"],
        ["a date-shaped id", "utm_id", "3-4"],
        ["a long numeric click id", "gclid", "1234567890123456789"],
        ["a click id with a leading zero", "gclid", "0123456789"],
    ];

    for (const [label, field, value] of cases) {
        it(`preserves ${label}`, () => {
            const row = buildRow(
                submission({ [field]: value }),
                turnstile,
                "2026-01-01T00:00:00.000Z",
            );

            assert.equal(row[COLUMNS.indexOf(field)], value);
        });
    }

    it("writes an apostrophe the visitor typed without doubling it", () => {
        const row = buildRow(
            submission({ name: "O'Brien" }),
            turnstile,
            "2026-01-01T00:00:00.000Z",
        );

        assert.equal(row[COLUMNS.indexOf("name")], "O'Brien");
    });
});

describe("spreadsheet row shape", () => {
    it("matches the 36-column header row the live sheet uses", () => {
        // Pinned deliberately: the sheet is shared with the resource form, and a
        // changed count here means the sheet's header row must change with it.
        assert.equal(COLUMNS.length, 36);
    });

    it("emits one cell per column, in column order", () => {
        const row = buildRow(submission(), turnstile, "2026-01-01T00:00:00.000Z");

        assert.equal(row.length, COLUMNS.length);
        assert.equal(row[COLUMNS.indexOf("timestamp")], "2026-01-01T00:00:00.000Z");
        assert.equal(row[COLUMNS.indexOf("form_type")], "contact");
        assert.equal(row[COLUMNS.indexOf("source")], "contact");
        assert.equal(row[COLUMNS.indexOf("turnstile_status")], "verified");
        assert.equal(row[COLUMNS.indexOf("turnstile_hostname")], "invaritech.ai");
    });

    it("keeps the columns owned by the resource form empty rather than absent", () => {
        const row = buildRow(submission(), turnstile, "2026-01-01T00:00:00.000Z");

        // Dropping these would shift every later value into the wrong column.
        assert.equal(row[COLUMNS.indexOf("role")], "");
        assert.equal(row[COLUMNS.indexOf("industry")], "");
        assert.equal(row[COLUMNS.indexOf("main_control_problem")], "");
    });

    it("carries attribution into its own columns", () => {
        const row = buildRow(
            submission({ utm_campaign: "spring", gclid: "abc123" }),
            turnstile,
            "2026-01-01T00:00:00.000Z",
        );

        assert.equal(row[COLUMNS.indexOf("utm_campaign")], "spring");
        assert.equal(row[COLUMNS.indexOf("gclid")], "abc123");
    });

    it("identifies invoice interest without changing the shared sheet shape", () => {
        const data = new FormData();
        data.set("email", "finance@example.com");
        data.set("interest", "three_way_matching");
        data.set("client_ref", "73969443-f5a7-4f35-a4be-18dc9127c685");
        data.set("cf_turnstile_token", "token");
        const parsed = parseInvoiceInterest(data, "HK");
        assert.equal(parsed.ok, true);

        const row = buildRow(parsed.submission, turnstile, "2026-01-01T00:00:00.000Z");
        assert.equal(row.length, COLUMNS.length);
        assert.equal(row[COLUMNS.indexOf("form_type")], "invoice_interest");
        assert.equal(row[COLUMNS.indexOf("source")], "three_way_matching");
        assert.equal(row[COLUMNS.indexOf("email")], "finance@example.com");
        assert.equal(row[COLUMNS.indexOf("country")], "HK");
        assert.equal(row[COLUMNS.indexOf("client_ref")], "73969443-f5a7-4f35-a4be-18dc9127c685");
    });
});

describe("email escaping", () => {
    it("shortens the browser reference for notifications", () => {
        assert.equal(shortClientRef("73969443-f5a7-4f35-a4be-18dc9127c685"), "73969…c685");
    });
    it("escapes HTML metacharacters", () => {
        assert.equal(
            escapeHtml('<script>alert("x")</script>'),
            "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
        );
    });

    it("neutralizes markup submitted in form fields", () => {
        const html = buildEmailHtml(
            submission({ name: "<img src=x onerror=alert(1)>", message: "<b>bold</b>" }),
            turnstile,
        );

        assert.ok(!html.includes("<img"));
        assert.ok(!html.includes("<b>bold</b>"));
        assert.ok(html.includes("&lt;img"));
    });

    it("never includes the Turnstile token", () => {
        const html = buildEmailHtml(submission({ cf_turnstile_token: "secret-token" }), turnstile);

        assert.ok(!html.includes("secret-token"));
    });
});

describe("input normalization", () => {
    it("strips control characters", () => {
        const withControls = "a" + String.fromCharCode(0) + "b" + String.fromCharCode(31) + "c";

        assert.equal(clean(withControls, 100), "abc");
    });

    it("caps length", () => {
        assert.equal(clean("x".repeat(50), 10).length, 10);
    });

    it("returns an empty string for uploaded files and other non-strings", () => {
        assert.equal(clean(new Blob(["data"]), 100), "");
        assert.equal(clean(null, 100), "");
    });
});
