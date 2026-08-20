/**
 * Runtime-agnostic contact handler.
 *
 * Uses only Web-standard Request/Response so it can be tested directly and
 * moved to another runtime without rewriting the logic. Provider calls are
 * injected so tests can exercise each failure path without network access.
 */

import { corsHeaders, isOriginAllowed } from "./cors.ts";
import { parseSubmission, type ContactSubmission } from "./fields.ts";
import { checkRateLimit } from "./rate-limit.ts";
import { clientIp, verifyTurnstile, type TurnstileResult } from "./turnstile.ts";
import { appendLeadRow } from "./sheets.ts";
import { sendNotification } from "./email.ts";

export interface ContactDeps {
    verifyTurnstile: (token: string, ip: string) => Promise<TurnstileResult>;
    appendLeadRow: (submission: ContactSubmission, turnstile: TurnstileResult) => Promise<void>;
    sendNotification: (submission: ContactSubmission, turnstile: TurnstileResult) => Promise<void>;
    checkRateLimit: (key: string) => boolean;
}

export const defaultDeps: ContactDeps = {
    verifyTurnstile,
    appendLeadRow,
    sendNotification,
    checkRateLimit: (key) => checkRateLimit(key),
};

const GENERIC_ERROR = "Unable to send your message. Please try again.";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);

function json(
    body: { success: boolean; error?: string },
    status: number,
    origin: string | null,
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...corsHeaders(origin),
        },
    });
}

/** CORS preflight. */
export function handlePreflight(request: Request): Response {
    const origin = request.headers.get("origin");
    if (!isOriginAllowed(origin)) {
        return json({ success: false, error: "Origin not allowed" }, 403, origin);
    }
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function handleContact(
    request: Request,
    deps: ContactDeps = defaultDeps,
): Promise<Response> {
    const origin = request.headers.get("origin");

    try {
        if (!isOriginAllowed(origin)) {
            return json({ success: false, error: "Origin not allowed" }, 403, origin);
        }

        const declaredLength = Number(request.headers.get("content-length") ?? 0);
        if (declaredLength > MAX_BODY_BYTES) {
            return json({ success: false, error: "Request too large." }, 413, origin);
        }

        const ip = clientIp(request.headers);
        if (!deps.checkRateLimit(ip || "unknown")) {
            return json(
                { success: false, error: "Too many requests. Please try again later." },
                429,
                origin,
            );
        }

        let form: FormData;
        try {
            form = await request.formData();
        } catch {
            return json({ success: false, error: "Invalid form submission." }, 400, origin);
        }

        const parsed = parseSubmission(form);
        if (!parsed.ok) {
            return json({ success: false, error: parsed.error }, 422, origin);
        }
        const submission = parsed.submission;

        const turnstile = await deps.verifyTurnstile(submission.turnstileToken, ip);
        if (turnstile.status === "unavailable") {
            return json({ success: false, error: GENERIC_ERROR }, 503, origin);
        }
        if (turnstile.status === "failed") {
            return json(
                { success: false, error: "Verification failed. Please try again." },
                422,
                origin,
            );
        }

        try {
            await deps.appendLeadRow(submission, turnstile);
        } catch {
            // No detail: provider errors can contain spreadsheet identifiers.
            console.error("contact: spreadsheet append failed");
            return json({ success: false, error: GENERIC_ERROR }, 503, origin);
        }

        try {
            await deps.sendNotification(submission, turnstile);
        } catch {
            // The lead is already recorded. Failing here would prompt a resubmit
            // and duplicate the row, so the notification is best-effort.
            console.error("contact: notification email failed");
        }

        return json({ success: true }, 201, origin);
    } catch {
        console.error("contact: unexpected failure");
        return json({ success: false, error: GENERIC_ERROR }, 500, origin);
    }
}
