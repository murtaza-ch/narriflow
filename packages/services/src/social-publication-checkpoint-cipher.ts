import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Prisma } from "@prisma/client";

export class PublicationCheckpointCipherError extends Error {
  readonly code = "publication_checkpoint_cipher_invalid";

  constructor(message: string) {
    super(message);
    this.name = "PublicationCheckpointCipherError";
  }
}

function keyFromSecret(secret: string) {
  const decoded = Buffer.from(secret, "base64");
  return decoded.length === 32
    ? decoded
    : createHash("sha256").update(secret).digest();
}

export function createPublicationCheckpointCipher(secret: string) {
  if (!secret.trim()) {
    throw new PublicationCheckpointCipherError(
      "SOCIAL_PUBLICATION_CHECKPOINT_KEY must not be empty",
    );
  }
  const key = keyFromSecret(secret);
  return {
    seal(value: Prisma.JsonObject): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      return [
        "v1",
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(":");
    },

    open(value: string): Prisma.JsonObject {
      const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
      if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) {
        throw new PublicationCheckpointCipherError(
          "Stored publication checkpoint uses an unsupported format",
        );
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(ivRaw, "base64url"),
        );
        decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
        const parsed = JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(ciphertextRaw, "base64url")),
            decipher.final(),
          ]).toString("utf8"),
        );
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("checkpoint is not an object");
        }
        return parsed as Prisma.JsonObject;
      } catch (error) {
        throw new PublicationCheckpointCipherError(
          error instanceof Error
            ? `Stored publication checkpoint could not be opened: ${error.message}`
            : "Stored publication checkpoint could not be opened",
        );
      }
    },
  };
}
