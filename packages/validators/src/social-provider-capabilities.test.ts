import { describe, expect, test } from "bun:test";
import { socialCaptionLength, xWeightedLength } from "./social-provider-capabilities";

describe("X weighted caption length", () => {
	test("counts Latin as 1, CJK and emoji as 2, and every link as 23", () => {
		expect(xWeightedLength("hello")).toBe(5);
		expect(xWeightedLength("你好世界")).toBe(8);
		expect(xWeightedLength("🙂")).toBe(2);
		expect(xWeightedLength("👨‍👩‍👧")).toBe(2);
		expect(xWeightedLength("👍🏽")).toBe(2);
		expect(xWeightedLength("🇵🇰")).toBe(2);
		expect(xWeightedLength("©")).toBe(1);
		expect(xWeightedLength("see https://example.com/a/very/long/path/that/goes/on/and/on?x=1 now")).toBe(4 + 23 + 4);
		expect(xWeightedLength("café")).toBe(4);
	});
	test("a 140-glyph CJK post fits and 141 does not; other platforms count characters", () => {
		expect(xWeightedLength("字".repeat(140))).toBe(280);
		expect(xWeightedLength("字".repeat(141))).toBe(282);
		expect(socialCaptionLength("x", "字".repeat(141))).toBe(282);
		expect(socialCaptionLength("tiktok", "字".repeat(141))).toBe(141);
	});
	test("trailing sentence punctuation after a link counts as text, not as part of the 23", () => {
		expect(xWeightedLength("see https://example.com.")).toBe(4 + 23 + 1);
		expect(xWeightedLength("(https://example.com/a)")).toBe(1 + 23 + 1);
		expect(xWeightedLength("really https://example.com/a?b=1!?")).toBe(7 + 23 + 2);
		expect(xWeightedLength("https://example.com/a, https://example.com/b.")).toBe(23 + 2 + 23 + 1);
		expect(xWeightedLength("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe(23);
	});
	test("a bare domain counts 23 however short, and ordinary dotted text does not", () => {
		expect(xWeightedLength("go to example.com now")).toBe(6 + 23 + 4);
		expect(xWeightedLength("Visit x.com, then bit.ly/abc!")).toBe(6 + 23 + 1 + 6 + 23 + 1);
		expect(xWeightedLength("a.co and example.com/path?x=1")).toBe(23 + 5 + 23);
		expect(xWeightedLength("www.example.com")).toBe(23);
		expect(xWeightedLength("mail me@example.com")).toBe(19);
		expect(xWeightedLength("e.g. node.js and index.py")).toBe(25);
	});
	test("a 200 KB run without spaces is measured in milliseconds", () => {
		const started = performance.now();
		xWeightedLength("a".repeat(200_000) + "." + "b".repeat(100_000));
		xWeightedLength("a.".repeat(100_000));
		xWeightedLength(`https://example.com/${")".repeat(100_000)}`);
		expect(performance.now() - started).toBeLessThan(500);
	});
});
