/**
 * Google Sheets append, using the REST API directly.
 *
 * The `googleapis` client depends on Node built-ins and does not run on
 * Workers, so the service-account JWT is signed here with WebCrypto and
 * exchanged for an access token. No dependencies.
 */

import { ATTRIBUTION_FIELDS, type ContactSubmission } from "./fields.ts";
import type { TurnstileResult } from "./turnstile.ts";
import type { Env } from "./env.ts";

/**
 * Column order of the leads spreadsheet. It must match the sheet's header row
 * exactly — appending a shorter row would silently shift every value after the
 * gap. `role`, `industry`, and `main_control_problem` belong to the resource
 * form that shares this sheet; the contact form writes them empty.
 */
export const COLUMNS = [
    "timestamp",
    "form_type",
    "source",
    "name",
    "email",
    "company",
    "phone",
    "country",
    "role",
    "industry",
    "main_control_problem",
    "message",
    ...ATTRIBUTION_FIELDS,
    "turnstile_status",
    "turnstile_hostname",
] as const;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/**
 * Neutralize spreadsheet formula injection. A leading apostrophe tells Sheets
 * to store the value as text; the apostrophe itself is not displayed.
 */
export function sanitizeForSheetCell(value: string): string {
    if (!value) return "";
    return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** Build the row in COLUMNS order, with every cell sanitized. */
export function buildRow(
    submission: ContactSubmission,
    turnstile: TurnstileResult,
    timestamp: string,
): string[] {
    const values: Record<string, string> = {
        timestamp,
        form_type: "contact",
        source: "contact",
        name: submission.name,
        email: submission.email,
        company: submission.company,
        phone: submission.phone,
        country: submission.country,
        role: "",
        industry: "",
        main_control_problem: "",
        message: submission.message,
        ...submission.attribution,
        turnstile_status: turnstile.status,
        turnstile_hostname: turnstile.hostname,
    };

    return COLUMNS.map((column) => sanitizeForSheetCell(values[column] ?? ""));
}

function base64url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeSegment(value: object): string {
    return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Decode a PEM private key into the DER bytes `importKey` expects. */
export function pemToPkcs8(pem: string): ArrayBuffer {
    const body = pem
        .replace(/\\n/g, "\n")
        .replace(/-----BEGIN [^-]+-----/, "")
        .replace(/-----END [^-]+-----/, "")
        .replace(/\s+/g, "");
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

// Cached per isolate. Google tokens last an hour; refresh a minute early.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(env: Env): Promise<string> {
    const clientEmail = env.GOOGLE_SHEETS_CLIENT_EMAIL?.trim();
    const privateKey = env.GOOGLE_SHEETS_PRIVATE_KEY;

    if (!clientEmail || !privateKey) {
        throw new Error("Google Sheets configuration missing");
    }

    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

    const claims = {
        iss: clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
    };
    const unsigned = `${encodeSegment({ alg: "RS256", typ: "JWT" })}.${encodeSegment(claims)}`;

    const key = await crypto.subtle.importKey(
        "pkcs8",
        pemToPkcs8(privateKey),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(unsigned),
    );

    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: `${unsigned}.${base64url(new Uint8Array(signature))}`,
        }).toString(),
    });

    if (!response.ok) {
        // Status only: the body can echo the client email back.
        throw new Error(`Google token endpoint responded with ${response.status}`);
    }

    const token = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!token.access_token) throw new Error("Google token response had no access_token");

    cachedToken = {
        value: token.access_token,
        expiresAt: now + (token.expires_in ?? 3600),
    };
    return cachedToken.value;
}

export async function appendLeadRow(
    env: Env,
    submission: ContactSubmission,
    turnstile: TurnstileResult,
): Promise<void> {
    const spreadsheetId = env.LEADS_SPREADSHEET_ID?.trim();
    if (!spreadsheetId) throw new Error("Google Sheets configuration missing");

    const sheetName = env.LEADS_SHEET_NAME?.trim() || "Sheet1";
    const range = encodeURIComponent(`${sheetName}!A:AI`);
    const url =
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
        `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${await accessToken(env)}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            values: [buildRow(submission, turnstile, new Date().toISOString())],
        }),
    });

    if (!response.ok) {
        throw new Error(`Sheets append responded with ${response.status}`);
    }
}

/** Test helper: clear the cached access token. */
export function resetTokenCache(): void {
    cachedToken = null;
}
