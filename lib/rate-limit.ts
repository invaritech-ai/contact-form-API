/**
 * Best-effort in-memory rate limiting.
 *
 * This is per-instance by design: the brief rules out adding a database or
 * other shared state, so a serverless deployment running N instances permits
 * up to N times the configured limit. It stops naive repeat submissions and
 * nothing more — Turnstile is the primary abuse control.
 */

interface Bucket {
    hits: number[];
}

const buckets = new Map<string, Bucket>();

function limit(): number {
    return Number(process.env.RATE_LIMIT_MAX ?? 5);
}

function windowMs(): number {
    return Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60) * 1000;
}

/** Returns true when the request is allowed. */
export function checkRateLimit(key: string, now: number = Date.now()): boolean {
    const cutoff = now - windowMs();

    // Opportunistic pruning keeps the map bounded without a timer.
    for (const [existingKey, bucket] of buckets) {
        bucket.hits = bucket.hits.filter((time) => time > cutoff);
        if (bucket.hits.length === 0) buckets.delete(existingKey);
    }

    const bucket = buckets.get(key) ?? { hits: [] };
    if (bucket.hits.length >= limit()) return false;

    bucket.hits.push(now);
    buckets.set(key, bucket);
    return true;
}

/** Test helper: drop all recorded state. */
export function resetRateLimit(): void {
    buckets.clear();
}
