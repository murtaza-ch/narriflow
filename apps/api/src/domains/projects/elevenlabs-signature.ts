import { createHmac, timingSafeEqual } from "node:crypto";

/** A delivery older than this is a replay, matching the official SDK's tolerance. */
export const SIGNATURE_MAX_AGE_SECONDS = 30 * 60;
/** Clock skew tolerated for a timestamp ahead of ours. The SDK has no future bound. */
export const SIGNATURE_MAX_FUTURE_SECONDS = 5 * 60;

export type SignatureFailure =
  | "missing_header"
  | "malformed_header"
  | "invalid_timestamp"
  | "expired"
  | "future"
  | "digest_mismatch";

const DIGEST_HEX = /^[0-9a-fA-F]{64}$/;
const TIMESTAMP = /^\d{1,12}$/;

/**
 * Verifies `elevenlabs-signature: t=<unix seconds>,v0=<hex>`: HMAC-SHA256 over
 * `<t>.<raw body bytes>` keyed by the secret string as given. The body is hashed
 * as received, so a Unicode byte or a whitespace change breaks the digest.
 * The comparison is constant-time.
 */
export function verifyElevenLabsSignature(input: {
  header: string | null | undefined;
  rawBody: Uint8Array;
  secret: string;
  nowMs: number;
}): { ok: true } | { ok: false; reason: SignatureFailure } {
  if (!input.header?.trim()) return { ok: false, reason: "missing_header" };
  const parts = input.header.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const digest = parts.find((part) => part.startsWith("v0="))?.slice(3);
  if (timestamp === undefined || digest === undefined) return { ok: false, reason: "malformed_header" };
  if (!TIMESTAMP.test(timestamp)) return { ok: false, reason: "invalid_timestamp" };
  if (!DIGEST_HEX.test(digest)) return { ok: false, reason: "malformed_header" };

  const ageSeconds = input.nowMs / 1000 - Number(timestamp);
  if (ageSeconds > SIGNATURE_MAX_AGE_SECONDS) return { ok: false, reason: "expired" };
  if (ageSeconds < -SIGNATURE_MAX_FUTURE_SECONDS) return { ok: false, reason: "future" };

  const expected = createHmac("sha256", input.secret).update(`${timestamp}.`).update(input.rawBody).digest();
  const provided = Buffer.from(digest, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "digest_mismatch" };
  }
  return { ok: true };
}
