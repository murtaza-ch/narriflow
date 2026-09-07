import {
  createCipheriv,
  createDecipheriv,
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

export interface GeneratedMediaPromptProtectionConfig {
  activeKeyVersion: string;
  encryptionKey: string;
  decryptionKeys: Readonly<Record<string, string>>;
  fingerprintKey: string;
}

const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function parseKeyVersion(value: string, label: string) {
  const version = value.trim();
  if (!KEY_VERSION_PATTERN.test(version)) {
    throw new GeneratedMediaPromptProtectionError(
      `${label} must contain 1-64 letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return version;
}

function parseKey(value: string, label: string) {
  const normalized = value.trim();
  const decoded = Buffer.from(normalized, "base64");
  const canonicalInput = normalized.replace(/=+$/, "");
  const canonicalDecoded = decoded.toString("base64").replace(/=+$/, "");
  if (decoded.length !== 32 || canonicalDecoded !== canonicalInput) {
    throw new GeneratedMediaPromptProtectionError(`${label} must be a 32-byte base64 key`);
  }
  return decoded;
}

function parseDecryptionKeys(value: string | undefined) {
  if (value === undefined) {
    throw new GeneratedMediaPromptProtectionError(
      "Generated media prompt decryption keys JSON is missing",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GeneratedMediaPromptProtectionError(
      "Generated media prompt decryption keys JSON is invalid",
    );
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new GeneratedMediaPromptProtectionError(
      "Generated media prompt decryption keys JSON must be an object",
    );
  }
  return Object.fromEntries(Object.entries(parsed).map(([version, key]) => {
    if (typeof key !== "string") {
      throw new GeneratedMediaPromptProtectionError(
        "Generated media prompt decryption key values must be strings",
      );
    }
    return [
      parseKeyVersion(version, "Generated media prompt decryption key version"),
      key,
    ];
  }));
}

export function generatedMediaPromptProtectionFromEnv(
  environment: Record<string, string | undefined> = process.env,
) {
  return createGeneratedMediaPromptProtection({
    activeKeyVersion: environment.GENERATED_MEDIA_PROMPT_ACTIVE_KEY_VERSION ?? "",
    encryptionKey: environment.GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY ?? "",
    decryptionKeys: parseDecryptionKeys(
      environment.GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON,
    ),
    fingerprintKey: environment.GENERATED_MEDIA_PROMPT_FINGERPRINT_KEY ?? "",
  });
}

export function createGeneratedMediaPromptProtection(
  config: GeneratedMediaPromptProtectionConfig,
): GeneratedMediaPromptProtection {
  const activeKeyVersion = parseKeyVersion(
    config.activeKeyVersion,
    "Generated media prompt active key version",
  );
  const encryptionKey = parseKey(
    config.encryptionKey,
    "Generated media prompt encryption key",
  );
  const fingerprintKey = parseKey(
    config.fingerprintKey,
    "Generated media prompt fingerprint key",
  );
  const decryptionKeys = new Map<string, Buffer>([[activeKeyVersion, encryptionKey]]);
  for (const [versionRaw, keyRaw] of Object.entries(config.decryptionKeys)) {
    const version = parseKeyVersion(versionRaw, "Generated media prompt decryption key version");
    if (version === activeKeyVersion) {
      throw new GeneratedMediaPromptProtectionError(
        "Generated media prompt decryption keys must not repeat the active key version",
      );
    }
    decryptionKeys.set(
      version,
      parseKey(keyRaw, `Generated media prompt decryption key ${version}`),
    );
  }

  return {
    protect(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return [
        "v2",
        activeKeyVersion,
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(":");
    },
    reveal(value) {
      const [formatVersion, keyVersion, ivRaw, tagRaw, ciphertextRaw, extra] = value.split(":");
      if (
        formatVersion !== "v2" || !keyVersion || !ivRaw || !tagRaw ||
        !ciphertextRaw || extra !== undefined
      ) {
        throw new GeneratedMediaPromptProtectionError("Protected prompt format is invalid");
      }
      const decryptionKey = decryptionKeys.get(keyVersion);
      if (!decryptionKey) {
        throw new GeneratedMediaPromptProtectionError(
          "Protected prompt key version is not configured",
        );
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          decryptionKey,
          Buffer.from(ivRaw, "base64url"),
        );
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
      return createHmac("sha256", fingerprintKey).update(value).digest("hex");
    },
  };
}
