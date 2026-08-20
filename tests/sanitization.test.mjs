import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asSheetText, buildRow, COLUMNS } from "../src/sheets.ts";
import { buildEmailHtml, escapeHtml } from "../src/email.ts";
import { clean, parseSubmission } from "../src/fields.ts";

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
    for (const prefix of ["=", "+", "-", "@"]) {
        it(`escapes a value beginning with ${prefix}`, () => {
            assert.equal(asSheetText(`${prefix}HYPERLINK("x")`), `'${prefix}HYPERLINK("x")`);
        });
    }

    it("escapes formula payloads submitted through form fields", () => {
        const row = buildRow(submission({ name: "=1+1" }), turnstile, "2026-01-01T00:00:00.000Z");

        assert.equal(row[COLUMNS.indexOf("name")], "'=1+1");
    });

    it("leaves an empty value empty rather than a bare apostrophe", () => {
        assert.equal(asSheetText(""), "");
    });
});

describe("numeric-looking values", () => {
    // USER_ENTERED parses values as though typed by hand, so every submitted
    // field is marked as text or Sheets rewrites it.
    const cases = [
        ["a phone number with a leading zero", "02079460000"],
        ["an international phone number", "+44 20 7946 0000"],
        ["a scientific-notation-shaped id", "1E5"],
        ["a date-shaped id", "3-4"],
        ["a long numeric click id", "1234567890123456789"],
    ];

    for (const [label, value] of cases) {
        it(`preserves ${label}`, () => {
            assert.equal(asSheetText(value), `'${value}`);
        });
    }

    it("preserves a leading-zero phone number written to the row", () => {
        const row = buildRow(
            submission({ phone: "02079460000" }),
            turnstile,
            "2026-01-01T00:00:00.000Z",
        );

        assert.equal(row[COLUMNS.indexOf("phone")], "'02079460000");
    });

    it("preserves a numeric click id written to the row", () => {
        const row = buildRow(
            submission({ gclid: "0123456789" }),
            turnstile,
            "2026-01-01T00:00:00.000Z",
        );

        assert.equal(row[COLUMNS.indexOf("gclid")], "'0123456789");
    });

    it("keeps an apostrophe the visitor typed", () => {
        const row = buildRow(
            submission({ name: "O'Brien" }),
            turnstile,
            "2026-01-01T00:00:00.000Z",
        );

        // The prefix is consumed by Sheets; the visitor's apostrophe survives.
        assert.equal(row[COLUMNS.indexOf("name")], "'O'Brien");
    });
});

describe("spreadsheet row shape", () => {
    it("matches the 35-column header row the live sheet uses", () => {
        // Pinned deliberately: the sheet is shared with the resource form, and a
        // changed count here means the sheet's header row must change with it.
        assert.equal(COLUMNS.length, 35);
    });

    it("emits one cell per column, in column order", () => {
        const row = buildRow(submission(), turnstile, "2026-01-01T00:00:00.000Z");

        assert.equal(row.length, COLUMNS.length);
        assert.equal(row[COLUMNS.indexOf("form_type")], "'contact");
        assert.equal(row[COLUMNS.indexOf("source")], "'contact");
        assert.equal(row[COLUMNS.indexOf("turnstile_status")], "'verified");
        assert.equal(row[COLUMNS.indexOf("turnstile_hostname")], "'invaritech.ai");
    });

    it("leaves the generated timestamp parseable as a date", () => {
        const row = buildRow(submission(), turnstile, "2026-01-01T00:00:00.000Z");

        assert.equal(row[COLUMNS.indexOf("timestamp")], "2026-01-01T00:00:00.000Z");
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

        assert.equal(row[COLUMNS.indexOf("utm_campaign")], "'spring");
        assert.equal(row[COLUMNS.indexOf("gclid")], "'abc123");
    });
});

describe("email escaping", () => {
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
