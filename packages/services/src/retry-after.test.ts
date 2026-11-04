import { expect, test } from "bun:test";
import { parseRetryAfterMs } from "./retry-after";

const now = new Date("2026-11-04T10:00:00Z");
test("reads delta-seconds and HTTP dates, and refuses anything else", () => {
	expect(parseRetryAfterMs("30", now)).toBe(30_000);
	expect(parseRetryAfterMs(" 1.5 ", now)).toBe(1_500);
	expect(parseRetryAfterMs("Wed, 04 Nov 2026 10:01:00 GMT", now)).toBe(60_000);
	expect(parseRetryAfterMs("Wed, 04 Nov 2026 09:00:00 GMT", now)).toBe(0);
	for (const value of [null, "", "soon", "-5", "0x10", "Infinity"]) expect(parseRetryAfterMs(value, now)).toBeNull();
});
