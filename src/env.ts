/**
 * Worker bindings and secrets.
 *
 * Workers receive configuration as an `env` argument rather than through
 * `process.env`, so every module here takes `Env` explicitly. That also keeps
 * the modules trivially testable: a test passes a plain object.
 */

/** Cloudflare's native rate limiting binding. */
export interface RateLimiter {
    limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
    // Secrets — set with `wrangler secret put`, never in wrangler.toml.
    TURNSTILE_SECRET_KEY?: string;
    GOOGLE_SHEETS_CLIENT_EMAIL?: string;
    GOOGLE_SHEETS_PRIVATE_KEY?: string;
    LEADS_SPREADSHEET_ID?: string;
    RESEND_API_KEY?: string;

    // Plain configuration — safe to keep in wrangler.toml [vars].
    LEADS_SHEET_NAME?: string;
    CONTACT_NOTIFICATION_FROM?: string;
    CONTACT_NOTIFICATION_TO?: string;
    ALLOWED_ORIGINS?: string;
    MAX_BODY_BYTES?: string;

    // Bindings.
    RATE_LIMITER?: RateLimiter;
}

export function numberFrom(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
