import { google } from "googleapis";
import { ATTRIBUTION_FIELDS, type ContactSubmission } from "./fields.ts";
import type { TurnstileResult } from "./turnstile.ts";

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

/**
 * Neutralize spreadsheet formula injection. A leading apostrophe tells Sheets
 * to store the value as text; the apostrophe itself is not displayed.
 */
export function sanitizeForSheetCell(value: string): string {
    if (!value) return "";
    return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function sheetsClient() {
    const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL?.trim();
    const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n");
    const spreadsheetId = process.env.LEADS_SPREADSHEET_ID?.trim();

    if (!clientEmail || !privateKey || !spreadsheetId) {
        throw new Error("Google Sheets configuration missing");
    }

    const auth = new google.auth.GoogleAuth({
        credentials: { client_email: clientEmail, private_key: privateKey },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    return { sheets: google.sheets({ version: "v4", auth }), spreadsheetId };
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

export async function appendLeadRow(
    submission: ContactSubmission,
    turnstile: TurnstileResult,
): Promise<void> {
    const { sheets, spreadsheetId } = sheetsClient();
    const sheetName = process.env.LEADS_SHEET_NAME?.trim() || "Sheet1";

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:AI`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [buildRow(submission, turnstile, new Date().toISOString())] },
    });
}
