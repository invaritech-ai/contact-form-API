/**
 * Rate limiting.
 *
 * Production uses Cloudflare's native rate limiting binding, which is enforced
 * across the whole account rather than per isolate. The in-memory fallback
 * exists only for `wrangler dev` runs and tests where no binding is bound.
 */

import type { Env } from "./env.ts";

const FALLBACK_LIMIT = 5;
const FALLBACK_WINDOW_MS = 60_000;

const memory = new Map<string, number[]>();

export async function checkRateLimit(
    env: Env,
    key: string,
    now: number = Date.now(),
): Promise<boolean> {
    if (env.RATE_LIMITER) {
        const { success } = await env.RATE_LIMITER.limit({ key });
        return success;
    }

    const cutoff = now - FALLBACK_WINDOW_MS;
    for (const [existingKey, hits] of memory) {
        const recent = hits.filter((time) => time > cutoff);
        if (recent.length === 0) memory.delete(existingKey);
        else memory.set(existingKey, recent);
    }

    const hits = memory.get(key) ?? [];
    if (hits.length >= FALLBACK_LIMIT) return false;

    hits.push(now);
    memory.set(key, hits);
    return true;
}

/** Test helper: drop all recorded state. */
export function resetRateLimit(): void {
    memory.clear();
}
