import { describe, expect, test } from "bun:test";
import {
  createGeneratedMediaPromptProtection,
  generatedMediaPromptProtectionFromEnv,
} from "./generated-media-prompt-protection";

const encryptionKeyV1 = Buffer.alloc(32, 1).toString("base64");
const encryptionKeyV2 = Buffer.alloc(32, 2).toString("base64");
const fingerprintKey = Buffer.alloc(32, 3).toString("base64");

describe("generated media prompt protection", () => {
  test("encrypts prompt material and creates a stable keyed fingerprint", () => {
    const protection = createGeneratedMediaPromptProtection({
      activeKeyVersion: "production-v1",
      encryptionKey: encryptionKeyV1,
      decryptionKeys: {},
      fingerprintKey,
    });
    const prompt = "Private transcript-derived visual context";
    const first = protection.protect(prompt);
    const second = protection.protect(prompt);

    expect(first).not.toContain(prompt);
    expect(first).not.toBe(second);
    expect(protection.reveal(first)).toBe(prompt);
    expect(protection.fingerprint(prompt)).toBe(protection.fingerprint(prompt));
    expect(protection.fingerprint(prompt)).not.toBe(protection.fingerprint(`${prompt}!`));
  });

  test("decrypts retained prompts after rotating the active encryption key", () => {
    const firstDeployment = createGeneratedMediaPromptProtection({
      activeKeyVersion: "production-v1",
      encryptionKey: encryptionKeyV1,
      decryptionKeys: {},
      fingerprintKey,
    });
    const encryptedBeforeRotation = firstDeployment.protect("private context");

    const rotatedDeployment = createGeneratedMediaPromptProtection({
      activeKeyVersion: "production-v2",
      encryptionKey: encryptionKeyV2,
      decryptionKeys: { "production-v1": encryptionKeyV1 },
      fingerprintKey,
    });

    expect(rotatedDeployment.reveal(encryptedBeforeRotation)).toBe("private context");
    expect(rotatedDeployment.fingerprint("private context")).toBe(
      firstDeployment.fingerprint("private context"),
    );
    expect(rotatedDeployment.protect("private context")).toStartWith("v2:production-v2:");
  });

  test("loads and validates the complete production key contract from env", () => {
    const protection = generatedMediaPromptProtectionFromEnv({
      GENERATED_MEDIA_PROMPT_ACTIVE_KEY_VERSION: "production-v2",
      GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY: encryptionKeyV2,
      GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON: JSON.stringify({
        "production-v1": encryptionKeyV1,
      }),
      GENERATED_MEDIA_PROMPT_FINGERPRINT_KEY: fingerprintKey,
    });

    expect(protection.reveal(protection.protect("private context"))).toBe("private context");
    expect(() => generatedMediaPromptProtectionFromEnv({
      GENERATED_MEDIA_PROMPT_ACTIVE_KEY_VERSION: "production-v1",
      GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY: encryptionKeyV1,
      GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON: "{}",
    })).toThrow("fingerprint");
    expect(() => generatedMediaPromptProtectionFromEnv({
      GENERATED_MEDIA_PROMPT_ACTIVE_KEY_VERSION: "production-v1",
      GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY: "not-a-32-byte-key",
      GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON: "{}",
      GENERATED_MEDIA_PROMPT_FINGERPRINT_KEY: fingerprintKey,
    })).toThrow("32-byte base64");
  });

  test("fails closed for unknown key versions and tampered ciphertext", () => {
    const protection = createGeneratedMediaPromptProtection({
      activeKeyVersion: "production-v1",
      encryptionKey: encryptionKeyV1,
      decryptionKeys: {},
      fingerprintKey,
    });
    const protectedPrompt = protection.protect("private context");
    expect(() => protection.reveal(`${protectedPrompt}tampered`)).toThrow();
    expect(() => protection.reveal(protectedPrompt.replace("production-v1", "retired-v0"))).toThrow(
      "key version",
    );
  });
});
