/** In-memory sliding-window rate limiter. One app process, so memory is enough. */
const buckets = new Map<string, number[]>();
let lastSweep = Date.now();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
	const now = Date.now();
	if (now - lastSweep > 600_000) {
		lastSweep = now;
		for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 3600_000) buckets.delete(k);
	}
	const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
	if (hits.length >= limit) {
		buckets.set(key, hits);
		return { ok: false, retryAfterSec: Math.ceil((windowMs - (now - hits[0])) / 1000) };
	}
	hits.push(now);
	buckets.set(key, hits);
	return { ok: true, retryAfterSec: 0 };
}

/** Forget failures for a key after a successful login. */
export function resetRateLimit(key: string) {
	buckets.delete(key);
}
