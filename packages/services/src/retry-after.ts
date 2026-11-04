/** A `Retry-After` header as milliseconds from `now`: delta-seconds or an
 * HTTP date. Null when absent or unreadable. */
export function parseRetryAfterMs(value: string | null, now: Date): number | null {
	const raw = value?.trim();
	if (!raw) return null;
	if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
	// Date.parse is lenient with numbers; an HTTP date always names its month.
	const at = /[A-Za-z]/.test(raw) ? Date.parse(raw) : NaN;
	return Number.isFinite(at) ? Math.max(0, at - now.getTime()) : null;
}
