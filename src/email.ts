import { ATTRIBUTION_FIELDS, type ContactSubmission } from "./fields.ts";
import type { TurnstileResult } from "./turnstile.ts";
import type { Env } from "./env.ts";

// The notification is best-effort; an abort is caught by the caller and logged.
const TIMEOUT_MS = 10_000;

/** Escape every user-supplied value before it enters the HTML email body. */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function row(label: string, value: string): string {
    if (!value) return "";
    return `<tr><td style="padding:4px 12px 4px 0;vertical-align:top;color:#666;white-space:nowrap">${escapeHtml(
        label,
    )}</td><td style="padding:4px 0;vertical-align:top">${escapeHtml(value).replace(
        /\n/g,
        "<br>",
    )}</td></tr>`;
}

export function buildEmailHtml(
    submission: ContactSubmission,
    turnstile: TurnstileResult,
): string {
    const contactRows = [
        row("Name", submission.name),
        row("Email", submission.email),
        row("Company", submission.company),
        row("Phone", submission.phone),
        row("Country", submission.country),
        row("Message", submission.message),
    ].join("");

    const attributionRows = ATTRIBUTION_FIELDS.map((field) =>
        row(field, submission.attribution[field]),
    ).join("");

    return [
        '<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">',
        `<h2 style="font-size:16px;margin:0 0 12px">${
            submission.formType === "invoice_interest"
                ? "New invoice workflow interest"
                : "New contact form submission"
        }</h2>`,
        `<table cellspacing="0" cellpadding="0">${contactRows}</table>`,
        attributionRows
            ? `<h3 style="font-size:14px;margin:20px 0 8px;color:#666">Attribution</h3><table cellspacing="0" cellpadding="0">${attributionRows}</table>`
            : "",
        `<p style="margin:20px 0 0;color:#999;font-size:12px">Turnstile: ${escapeHtml(
            turnstile.status,
        )}${turnstile.hostname ? ` (${escapeHtml(turnstile.hostname)})` : ""}</p>`,
        "</div>",
    ].join("");
}

/**
 * Send the notification through Resend. The Turnstile token and every
 * credential are deliberately absent from the payload.
 */
export async function sendNotification(
    env: Env,
    submission: ContactSubmission,
    turnstile: TurnstileResult,
): Promise<void> {
    const apiKey = env.RESEND_API_KEY?.trim();
    const from = env.CONTACT_NOTIFICATION_FROM?.trim();
    const to = (env.CONTACT_NOTIFICATION_TO ?? "")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);

    if (!apiKey || !from || to.length === 0) {
        throw new Error("Resend configuration missing");
    }

    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            from,
            to,
            reply_to: submission.email,
            subject:
                submission.formType === "invoice_interest"
                    ? `New invoice workflow lead: ${submission.source}`
                    : `New contact form submission from ${submission.name}`,
            html: buildEmailHtml(submission, turnstile),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
        // Status only: the body can echo back submitted content.
        throw new Error(`Resend responded with ${response.status}`);
    }
}
