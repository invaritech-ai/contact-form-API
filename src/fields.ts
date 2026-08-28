/**
 * Field parsing, normalization, and validation.
 *
 * Every value that reaches the spreadsheet or the notification email passes
 * through `clean()` first: it is length-capped here so that a hostile payload
 * cannot push a huge string into Sheets or the email body.
 */

export const ATTRIBUTION_FIELDS = [
    "submit_page_url",
    "submit_page_path",
    "submit_page_title",
    "referrer",
    "landing_page_url",
    "landing_page_path",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "utm_source_platform",
    "utm_creative_format",
    "utm_marketing_tactic",
    "gclid",
    "gbraid",
    "wbraid",
    "fbclid",
    "msclkid",
    "li_fat_id",
] as const;

export type AttributionField = (typeof ATTRIBUTION_FIELDS)[number];
export type Attribution = Record<AttributionField, string>;
export type InvoiceInterest = "invoice_pipeline" | "three_way_matching";

export interface ContactSubmission {
    formType: "contact" | "invoice_interest";
    source: "contact" | InvoiceInterest;
    name: string;
    email: string;
    phone: string;
    company: string;
    country: string;
    message: string;
    turnstileToken: string;
    attribution: Attribution;
}

const LIMITS = {
    name: 200,
    email: 320,
    phone: 60,
    company: 200,
    country: 100,
    message: 5000,
    token: 4096,
    attribution: 600,
} as const;

// Deliberately permissive: the authoritative check is whether mail is delivered.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// C0 and C1 control characters, written as escapes to keep this file printable.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

/** Normalize, strip control characters, trim, and cap length. */
export function clean(value: unknown, maxLength: number): string {
    if (typeof value !== "string") return "";
    return value.normalize("NFKC").replace(CONTROL_CHARS, "").trim().slice(0, maxLength);
}

export type ParseResult =
    | { ok: true; submission: ContactSubmission }
    | { ok: false; error: string };

export function parseSubmission(form: FormData): ParseResult {
    const name = clean(form.get("name"), LIMITS.name);
    const email = clean(form.get("email"), LIMITS.email);
    const phone = clean(form.get("phone"), LIMITS.phone);
    const company = clean(form.get("company"), LIMITS.company);
    const country = clean(form.get("country"), LIMITS.country);
    const message = clean(form.get("message"), LIMITS.message);
    const turnstileToken = clean(form.get("cf_turnstile_token"), LIMITS.token);

    if (!name) return { ok: false, error: "Name is required" };
    if (!email) return { ok: false, error: "Email is required" };
    if (!EMAIL_RE.test(email)) {
        return { ok: false, error: "Please enter a valid email address" };
    }
    if (!country) return { ok: false, error: "Country is required" };
    if (!message) return { ok: false, error: "Message is required" };
    if (!turnstileToken) {
        return { ok: false, error: "Please complete the verification" };
    }

    const attribution = {} as Attribution;
    for (const field of ATTRIBUTION_FIELDS) {
        attribution[field] = clean(form.get(field), LIMITS.attribution);
    }

    return {
        ok: true,
        submission: {
            formType: "contact",
            source: "contact",
            name,
            email,
            phone,
            company,
            country,
            message,
            turnstileToken,
            attribution,
        },
    };
}

const INTEREST_COPY: Record<InvoiceInterest, { name: string; message: string }> = {
    invoice_pipeline: {
        name: "Invoice pipeline interest",
        message:
            "Interested in invoice intake from email and approved posting to accounting software such as Xero.",
    },
    three_way_matching: {
        name: "Matching workflow interest",
        message:
            "Interested in account-required matching, reconciliation, and exception workflows for invoices, purchase orders, and bank statements.",
    },
};

export function parseInvoiceInterest(form: FormData, edgeCountry: string | null): ParseResult {
    const email = clean(form.get("email"), LIMITS.email);
    const interest = clean(form.get("interest"), 40) as InvoiceInterest;
    const turnstileToken = clean(form.get("cf_turnstile_token"), LIMITS.token);

    if (!email) return { ok: false, error: "Email is required" };
    if (!EMAIL_RE.test(email)) {
        return { ok: false, error: "Please enter a valid email address" };
    }
    if (!Object.hasOwn(INTEREST_COPY, interest)) {
        return { ok: false, error: "Please choose an interest" };
    }
    if (!turnstileToken) {
        return { ok: false, error: "Please complete the verification" };
    }

    const attribution = {} as Attribution;
    for (const field of ATTRIBUTION_FIELDS) {
        attribution[field] = clean(form.get(field), LIMITS.attribution);
    }

    const copy = INTEREST_COPY[interest];
    return {
        ok: true,
        submission: {
            formType: "invoice_interest",
            source: interest,
            name: copy.name,
            email,
            phone: "",
            company: "",
            country: clean(edgeCountry, LIMITS.country) || "Unknown",
            message: copy.message,
            turnstileToken,
            attribution,
        },
    };
}
