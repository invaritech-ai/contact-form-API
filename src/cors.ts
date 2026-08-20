/**
 * Origin allowlisting. ALLOWED_ORIGINS is a comma-separated list of exact
 * origins, e.g. "https://invaritech.ai,https://www.invaritech.ai".
 *
 * Requests without an Origin header (curl, server-to-server) are allowed
 * through: the header is browser-supplied, so its absence is not a signal
 * that anything is wrong, and Turnstile remains the real gate.
 */

import type { Env } from "./env.ts";

export function allowedOrigins(env: Env): string[] {
    return (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

export function isOriginAllowed(env: Env, origin: string | null): boolean {
    if (!origin) return true;
    return allowedOrigins(env).includes(origin);
}

/** CORS headers to echo back, or none when the request carries no Origin. */
export function corsHeaders(env: Env, origin: string | null): Record<string, string> {
    if (!origin || !isOriginAllowed(env, origin)) return { Vary: "Origin" };
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
}
