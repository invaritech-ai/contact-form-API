/** Cloudflare Turnstile server-side verification. */

import type { Env } from "./env.ts";

export interface TurnstileResult {
    status: "verified" | "failed" | "unavailable";
    hostname: string;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// A stalled upstream must not hold the request open; an abort lands in the
// catch below and is reported as "unavailable".
const TIMEOUT_MS = 5_000;

/**
 * Client IP for Turnstile's optional `remoteip`.
 *
 * On Workers, `CF-Connecting-IP` is set by the edge and cannot be spoofed by
 * the client, so it is the only header trusted here.
 */
export function clientIp(headers: Headers): string {
    return headers.get("cf-connecting-ip")?.trim() ?? "";
}

export async function verifyTurnstile(
    env: Env,
    token: string,
    ip: string,
): Promise<TurnstileResult> {
    const secret = env.TURNSTILE_SECRET_KEY?.trim();
    if (!secret) {
        console.error("turnstile: TURNSTILE_SECRET_KEY is not configured");
        return { status: "unavailable", hostname: "" };
    }

    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);

    try {
        const response = await fetch(SITEVERIFY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!response.ok) {
            console.error("turnstile: siteverify returned", response.status);
            return { status: "unavailable", hostname: "" };
        }

        const result = (await response.json()) as { success?: boolean; hostname?: string };
        return {
            status: result.success === true ? "verified" : "failed",
            hostname: typeof result.hostname === "string" ? result.hostname : "",
        };
    } catch {
        console.error("turnstile: siteverify request failed");
        return { status: "unavailable", hostname: "" };
    }
}
