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

// An abort surfaces as a thrown error, which handleContact maps to 503.
const TIMEOUT_MS = 10_000;
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/**
 * Values are written with `valueInputOption=RAW`, which is the safety control
 * for this sheet: Sheets stores each value exactly as given instead of parsing
 * it as though typed into the grid. Formulas are therefore inert text, and
 * nothing number-shaped is rewritten — `02079460000` keeps its leading zero,
 * `1E5` stays `1E5`, and `3-4` does not become a date. No escaping is applied,
 * so values appear in the sheet exactly as the visitor submitted them.
 */
const VALUE_INPUT_OPTION = "RAW";

/** Build the row in COLUMNS order. Values are written verbatim; see RAW above. */
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

    return COLUMNS.map((column) => values[column] ?? "");
}

/** 1-based column index to its A1 letter: 1 -> A, 27 -> AA, 35 -> AI. */
export function columnLetter(index: number): string {
    let letter = "";
    for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
        letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter;
    }
    return letter;
}

export const LAST_COLUMN = columnLetter(COLUMNS.length);

/**
 * Quote a sheet name for A1 notation. Names containing spaces, punctuation, or
 * anything that parses as a cell reference are invalid unquoted, and an
 * embedded apostrophe is escaped by doubling it. Quoting is always valid, so
 * plain names are quoted too rather than special-cased.
 */
export function quoteSheetName(name: string): string {
    return `'${name.replace(/'/g, "''")}'`;
}

/**
 * Google error bodies echo the spreadsheet ID back ("Requested entity was not
 * found: spreadsheets/<id>"), so it is replaced before anything is logged.
 * Messages are also capped, since they can carry the submitted range.
 */
export function scrubGoogleMessage(message: string, spreadsheetId?: string): string {
    const capped = message.slice(0, 300);
    return spreadsheetId ? capped.split(spreadsheetId).join("[spreadsheet-id]") : capped;
}

/**
 * Describe a thrown error for logging. A network failure, a DNS problem, or an
 * AbortSignal timeout never reaches the response helpers below, so without this
 * the only trace would be the caller's generic message.
 */
export function describeThrown(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return { name: error.name, message: error.message.slice(0, 200) };
    }
    return { name: "unknown", message: String(error).slice(0, 200) };
}

/** Read a failed Google response into loggable fields. Never includes tokens. */
async function describeFailure(
    response: Response,
    spreadsheetId?: string,
): Promise<Record<string, unknown>> {
    let parsed: Record<string, unknown> = {};
    try {
        const body = (await response.json()) as {
            error?: { code?: number; status?: string; message?: string } | string;
            error_description?: string;
        };
        if (typeof body.error === "string") {
            // Token endpoint shape: { error, error_description }
            parsed = { error: body.error, description: body.error_description };
        } else if (body.error) {
            parsed = {
                code: body.error.code,
                status: body.error.status,
                message: body.error.message
                    ? scrubGoogleMessage(body.error.message, spreadsheetId)
                    : undefined,
            };
        }
    } catch {
        parsed = { note: "response body was not JSON" };
    }
    return { httpStatus: response.status, ...parsed };
}

function base64url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeSegment(value: object): string {
    return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Decode a PEM private key into the DER bytes `importKey` expects.
 *
 * Tolerant of how the value tends to arrive. Secret stores are routinely fed
 * the quoted form copied out of a .env file, and workerd's `atob` rejects the
 * stray quote where Node's accepts it — so the wrapper is stripped here, along
 * with anything else outside the base64 alphabet.
 */
export function pemToPkcs8(pem: string): ArrayBuffer {
    const body = pem
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/\\n/g, "\n")
        .replace(/-----BEGIN [^-]+-----/, "")
        .replace(/-----END [^-]+-----/, "")
        .replace(/[^A-Za-z0-9+/=]/g, "");
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
        // Presence only — neither value is ever logged.
        console.error(
            "sheets: credentials missing",
            JSON.stringify({
                clientEmailPresent: Boolean(clientEmail),
                privateKeyPresent: Boolean(privateKey),
            }),
        );
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

    let key: CryptoKey;
    try {
        key = await crypto.subtle.importKey(
            "pkcs8",
            pemToPkcs8(privateKey),
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["sign"],
        );
    } catch {
        // The usual cause is a value pasted with surrounding quotes, or with the
        // \n escapes already expanded into real newlines by the secret store.
        console.error(
            "sheets: private key could not be parsed",
            JSON.stringify({
                length: privateKey.length,
                startsWithPemHeader: privateKey.trimStart().startsWith("-----BEGIN"),
                hasEscapedNewlines: privateKey.includes("\\n"),
                hasRealNewlines: privateKey.includes("\n"),
            }),
        );
        throw new Error("Google Sheets private key is not usable");
    }
    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(unsigned),
    );

    let response: Response;
    try {
        response = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: `${unsigned}.${base64url(new Uint8Array(signature))}`,
            }).toString(),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        console.error("sheets: token request did not complete", JSON.stringify(describeThrown(error)));
        throw new Error("Google token request failed");
    }

    if (!response.ok) {
        console.error("sheets: token exchange failed", JSON.stringify(await describeFailure(response)));
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
    if (!spreadsheetId) {
        console.error("sheets: LEADS_SPREADSHEET_ID is not set");
        throw new Error("Google Sheets configuration missing");
    }

    const sheetName = env.LEADS_SHEET_NAME?.trim() || "Sheet1";
    const range = encodeURIComponent(`${quoteSheetName(sheetName)}!A:${LAST_COLUMN}`);
    const url =
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
        `/values/${range}:append?valueInputOption=${VALUE_INPUT_OPTION}&insertDataOption=INSERT_ROWS`;

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${await accessToken(env)}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                values: [buildRow(submission, turnstile, new Date().toISOString())],
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        console.error(
            "sheets: append request did not complete",
            JSON.stringify({ ...describeThrown(error), sheetName }),
        );
        throw new Error("Sheets append request failed");
    }

    if (!response.ok) {
        console.error(
            "sheets: append failed",
            JSON.stringify({
                ...(await describeFailure(response, spreadsheetId)),
                sheetName,
                range: `${quoteSheetName(sheetName)}!A:${LAST_COLUMN}`,
                spreadsheetIdPresent: true,
                spreadsheetIdLength: spreadsheetId.length,
            }),
        );
        throw new Error(`Sheets append responded with ${response.status}`);
    }

    console.log("sheets: append ok", JSON.stringify({ httpStatus: response.status, sheetName }));
}

/** Test helper: clear the cached access token. */
export function resetTokenCache(): void {
    cachedToken = null;
}
