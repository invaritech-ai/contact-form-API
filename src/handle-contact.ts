/**
 * Contact request handler.
 *
 * Uses only Web-standard Request/Response. Provider calls are injected so
 * tests can exercise every failure path without network access.
 */

import { corsHeaders, isOriginAllowed } from "./cors.ts";
import { parseSubmission, type ContactSubmission } from "./fields.ts";
import { checkRateLimit } from "./rate-limit.ts";
import { clientIp, verifyTurnstile, type TurnstileResult } from "./turnstile.ts";
import { appendLeadRow } from "./sheets.ts";
import { sendNotification } from "./email.ts";
import { numberFrom, type Env } from "./env.ts";
import { readLimitedFormData } from "./body.ts";

export interface ContactDeps {
    verifyTurnstile: (env: Env, token: string, ip: string) => Promise<TurnstileResult>;
    appendLeadRow: (
        env: Env,
        submission: ContactSubmission,
        turnstile: TurnstileResult,
    ) => Promise<void>;
    sendNotification: (
        env: Env,
        submission: ContactSubmission,
        turnstile: TurnstileResult,
    ) => Promise<void>;
    checkRateLimit: (env: Env, key: string) => Promise<boolean>;
}

export const defaultDeps: ContactDeps = {
    verifyTurnstile,
    appendLeadRow,
    sendNotification,
    checkRateLimit,
};

const GENERIC_ERROR = "Unable to send your message. Please try again.";
const DEFAULT_MAX_BODY_BYTES = 100_000;

function json(
    env: Env,
    body: { success: boolean; error?: string },
    status: number,
    origin: string | null,
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...corsHeaders(env, origin),
        },
    });
}

/** CORS preflight. */
export function handlePreflight(request: Request, env: Env): Response {
    const origin = request.headers.get("origin");
    if (!isOriginAllowed(env, origin)) {
        return json(env, { success: false, error: "Origin not allowed" }, 403, origin);
    }
    return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
}

export async function handleContact(
    request: Request,
    env: Env,
    deps: ContactDeps = defaultDeps,
): Promise<Response> {
    const origin = request.headers.get("origin");

    try {
        if (!isOriginAllowed(env, origin)) {
            return json(env, { success: false, error: "Origin not allowed" }, 403, origin);
        }

        const ip = clientIp(request.headers);
        if (!(await deps.checkRateLimit(env, ip || "unknown"))) {
            return json(
                env,
                { success: false, error: "Too many requests. Please try again later." },
                429,
                origin,
            );
        }

        const maxBytes = numberFrom(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
        const body = await readLimitedFormData(request, maxBytes);
        if (!body.ok) {
            return body.reason === "too-large"
                ? json(env, { success: false, error: "Request too large." }, 413, origin)
                : json(env, { success: false, error: "Invalid form submission." }, 400, origin);
        }

        const parsed = parseSubmission(body.form);
        if (!parsed.ok) {
            return json(env, { success: false, error: parsed.error }, 422, origin);
        }
        const submission = parsed.submission;

        const turnstile = await deps.verifyTurnstile(env, submission.turnstileToken, ip);
        if (turnstile.status === "unavailable") {
            return json(env, { success: false, error: GENERIC_ERROR }, 503, origin);
        }
        if (turnstile.status === "failed") {
            return json(
                env,
                { success: false, error: "Verification failed. Please try again." },
                422,
                origin,
            );
        }

        try {
            await deps.appendLeadRow(env, submission, turnstile);
        } catch {
            // No detail: provider errors can contain spreadsheet identifiers.
            console.error("contact: spreadsheet append failed");
            return json(env, { success: false, error: GENERIC_ERROR }, 503, origin);
        }

        try {
            await deps.sendNotification(env, submission, turnstile);
        } catch {
            // The lead is already recorded. Failing here would prompt a resubmit
            // and duplicate the row, so the notification is best-effort.
            console.error("contact: notification email failed");
        }

        return json(env, { success: true }, 201, origin);
    } catch {
        console.error("contact: unexpected failure");
        return json(env, { success: false, error: GENERIC_ERROR }, 500, origin);
    }
}
