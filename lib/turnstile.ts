/** Cloudflare Turnstile server-side verification. */

export interface TurnstileResult {
    status: "verified" | "failed" | "unavailable";
    hostname: string;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Client IP for Turnstile's optional `remoteip`.
 *
 * Only headers the hosting platform itself sets are trusted. `x-forwarded-for`
 * is included because Vercel overwrites it at the edge; on a platform that
 * merely forwards a client-supplied value, drop it from this list.
 */
export function clientIp(headers: Headers): string {
    const candidates = [
        headers.get("cf-connecting-ip"),
        headers.get("x-real-ip"),
        headers.get("x-forwarded-for")?.split(",")[0],
    ];
    for (const candidate of candidates) {
        const ip = candidate?.trim();
        if (ip) return ip;
    }
    return "";
}

export async function verifyTurnstile(token: string, ip: string): Promise<TurnstileResult> {
    const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
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
