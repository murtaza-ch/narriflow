import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { GeneratedMediaPromptProtection } from "./generated-media";

export class GeneratedMediaPromptProtectionError extends Error {
  readonly code = "generated_media_prompt_protection_invalid";

  constructor(message: string) {
    super(message);
    this.name = "GeneratedMediaPromptProtectionError";
  }
}

export function createGeneratedMediaPromptProtection(secret: string): GeneratedMediaPromptProtection {
  if (!secret.trim()) {
    throw new GeneratedMediaPromptProtectionError("Generated media prompt protection key is missing");
  }
  const decoded = Buffer.from(secret, "base64");
  const key = decoded.length === 32 ? decoded : createHash("sha256").update(secret).digest();

  return {
    protect(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return [
        "v1",
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(":");
    },
    reveal(value) {
      const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
      if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) {
        throw new GeneratedMediaPromptProtectionError("Protected prompt format is invalid");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
        decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertextRaw, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new GeneratedMediaPromptProtectionError("Protected prompt could not be opened");
      }
    },
    fingerprint(value) {
      return createHmac("sha256", key).update(value).digest("hex");
    },
  };
}
