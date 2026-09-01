import { describe, expect, test } from "bun:test";
import { createGeneratedMediaPromptProtection } from "./generated-media-prompt-protection";

describe("generated media prompt protection", () => {
  test("encrypts prompt material and creates a stable keyed fingerprint", () => {
    const protection = createGeneratedMediaPromptProtection("test-only-secret");
    const prompt = "Private transcript-derived visual context";
    const first = protection.protect(prompt);
    const second = protection.protect(prompt);

    expect(first).not.toContain(prompt);
    expect(first).not.toBe(second);
    expect(protection.reveal(first)).toBe(prompt);
    expect(protection.fingerprint(prompt)).toBe(protection.fingerprint(prompt));
    expect(protection.fingerprint(prompt)).not.toBe(protection.fingerprint(`${prompt}!`));
  });

  test("fails closed for missing keys and tampered ciphertext", () => {
    expect(() => createGeneratedMediaPromptProtection(" ")).toThrow();
    const protection = createGeneratedMediaPromptProtection("test-only-secret");
    const protectedPrompt = protection.protect("private context");
    expect(() => protection.reveal(`${protectedPrompt}tampered`)).toThrow();
  });
});
