/**
 * Origin allowlisting. ALLOWED_ORIGINS is a comma-separated list of exact
 * origins, e.g. "https://invaritech.ai,https://www.invaritech.ai".
 *
 * Requests without an Origin header (curl, server-to-server) are allowed
 * through: the header is browser-supplied, so its absence is not a signal
 * that anything is wrong, and Turnstile remains the real gate.
 */

export function allowedOrigins(): string[] {
    return (process.env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

export function isOriginAllowed(origin: string | null): boolean {
    if (!origin) return true;
    return allowedOrigins().includes(origin);
}

/** CORS headers to echo back, or none when the request carries no Origin. */
export function corsHeaders(origin: string | null): Record<string, string> {
    if (!origin || !isOriginAllowed(origin)) return { Vary: "Origin" };
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
}
