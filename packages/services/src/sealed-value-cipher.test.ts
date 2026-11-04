import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createCallbackCipher } from "./completion-callback";
import { createSealedValueCipher } from "./sealed-value-cipher";

test("seals and opens in the v1 form, with a fresh IV each time", () => {
	const cipher = createSealedValueCipher(randomBytes(32), () => new Error("bad shape"));
	const first = cipher.seal("secret value");
	expect(first.split(":")).toHaveLength(4);
	expect(first.startsWith("v1:")).toBe(true);
	expect(cipher.seal("secret value")).not.toBe(first);
	expect(cipher.open(first)).toBe("secret value");
});

test("a malformed or foreign value fails, with the caller's own error for the shape", () => {
	const cipher = createSealedValueCipher(randomBytes(32), () => new Error("bad shape"));
	expect(() => cipher.open("not-sealed")).toThrow("bad shape");
	expect(() => cipher.open("v2:a:b:c")).toThrow("bad shape");
	const foreign = createSealedValueCipher(randomBytes(32), () => new Error("x")).seal("v");
	expect(() => cipher.open(foreign)).toThrow();
});

test("callback values keep their sealed form", () => {
	const callbacks = createCallbackCipher("a-test-key-material-not-a-secret");
	expect(callbacks.open(callbacks.seal("https://example.com/hook"))).toBe("https://example.com/hook");
	expect(() => callbacks.open("nope")).toThrow("Unsupported sealed callback value");
});
