import { describe, expect, test } from "bun:test";

import { createGeneratedMediaPromptProtection } from "./generated-media";

const binding = {
	workspaceId: "00000000-0000-4000-8000-000000000301",
	projectId: "00000000-0000-4000-8000-000000000302",
	clipId: "00000000-0000-4000-8000-000000000303",
	kind: "image" as const,
	idempotencyKey: "00000000-0000-4000-8000-000000000304",
	requestFingerprint: "request-fingerprint-a",
	promptFingerprint: "prompt-fingerprint-a",
};

describe("generated media prompt protection", () => {
	test("rejects weak or reused key material at the public factory", () => {
		expect(() =>
			createGeneratedMediaPromptProtection({
				activeKeyVersion: "primary",
				encryptionKeys: { primary: "too-short" },
				fingerprintKey: "independent-fingerprint-key-with-at-least-32-characters",
			}),
		).toThrow("at least 32");
		const repeated = "repeated-protection-key-with-at-least-32-characters";
		expect(() =>
			createGeneratedMediaPromptProtection({
				activeKeyVersion: "primary",
				encryptionKeys: { primary: repeated },
				fingerprintKey: repeated,
			}),
		).toThrow("independent");
	});

	test("binds ciphertext authentication to its job identity", () => {
		const protection = createGeneratedMediaPromptProtection({
			activeKeyVersion: "2026-08-primary",
			encryptionKeys: {
				"2026-08-primary": "active-encryption-key-with-at-least-32-characters",
			},
			fingerprintKey: "fingerprint-key-with-at-least-32-characters",
		});
		const sealed = protection.seal(
			{ prompt: "A quiet studio", derivedContext: null },
			binding,
		);

		expect(sealed.keyVersion).toBe("2026-08-primary");
		expect(protection.open(sealed, binding)).toEqual({
			prompt: "A quiet studio",
			derivedContext: null,
		});
		expect(() =>
			protection.open(sealed, {
				...binding,
				workspaceId: "00000000-0000-4000-8000-000000000399",
			}),
		).toThrow("generated_media_prompt_unreadable");
	});

	test("decrypts an in-flight prompt after the active key rotates", () => {
		const oldKey = "old-encryption-key-with-at-least-32-characters";
		const newKey = "new-encryption-key-with-at-least-32-characters";
		const fingerprintKey = "fingerprint-key-with-at-least-32-characters";
		const beforeRotation = createGeneratedMediaPromptProtection({
			activeKeyVersion: "2026-08",
			encryptionKeys: { "2026-08": oldKey },
			fingerprintKey,
		});
		const sealed = beforeRotation.seal(
			{ prompt: "Retain this queued prompt", derivedContext: "A source cue" },
			binding,
		);
		const afterRotation = createGeneratedMediaPromptProtection({
			activeKeyVersion: "2026-09",
			encryptionKeys: { "2026-08": oldKey, "2026-09": newKey },
			fingerprintKey,
		});

		expect(afterRotation.open(sealed, binding)).toEqual({
			prompt: "Retain this queued prompt",
			derivedContext: "A source cue",
		});
		expect(
			afterRotation.seal(
				{ prompt: "New prompt", derivedContext: null },
				binding,
			).keyVersion,
		).toBe("2026-09");
	});
});
