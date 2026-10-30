import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyElevenLabsSignature } from "./elevenlabs-signature";

const SECRET = "wsec_test_secret";
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const encoder = new TextEncoder();

function sign(body: Uint8Array | string, t: number | string = NOW_S, secret = SECRET): string {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const digest = createHmac("sha256", secret).update(`${t}.`).update(bytes).digest("hex");
  return `t=${t},v0=${digest}`;
}

const verify = (header: string | null | undefined, body: Uint8Array | string, nowMs = NOW_MS) =>
  verifyElevenLabsSignature({
    header,
    rawBody: typeof body === "string" ? encoder.encode(body) : body,
    secret: SECRET,
    nowMs,
  });

describe("ElevenLabs signature", () => {
  const body = '{"type":"speech_to_text_transcription","data":{}}';

  test("accepts a valid signature, also over the SDK's string form of the message", () => {
    expect(verify(sign(body), body)).toEqual({ ok: true });
    // The official SDK hashes `${t}.${rawBody}` as one UTF-8 string and compares "v0=" + hex.
    const sdkDigest = createHmac("sha256", SECRET).update(`${NOW_S}.${body}`).digest("hex");
    expect(verify(`t=${NOW_S},v0=${sdkDigest}`, body)).toEqual({ ok: true });
  });

  test("hashes Unicode bodies as received bytes", () => {
    const unicode = '{"text":"مرحبا 你好 🎬 \u00e9"}';
    expect(verify(sign(unicode), unicode)).toEqual({ ok: true });
    const mutated = unicode.replace("\u00e9", "e\u0301"); // composed vs decomposed é
    expect(verify(sign(unicode), mutated)).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  test("any whitespace mutation of the body breaks the digest", () => {
    for (const mutated of [` ${body}`, `${body}\n`, body.replace(":", ": "), body.replace(",", ", ")]) {
      expect(verify(sign(body), mutated)).toEqual({ ok: false, reason: "digest_mismatch" });
    }
  });

  test("rejects a missing header", () => {
    for (const header of [null, undefined, "", "   "]) {
      expect(verify(header, body)).toEqual({ ok: false, reason: "missing_header" });
    }
  });

  test("rejects malformed headers", () => {
    const digest = "a".repeat(64);
    expect(verify("garbage", body)).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(`v0=${digest}`, body)).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(`t=${NOW_S}`, body)).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(`t=${NOW_S},v1=${digest}`, body)).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(`t=${NOW_S},v0=${digest.slice(0, 62)}`, body)).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(`t=${NOW_S},v0=${"z".repeat(64)}`, body)).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(`t=${NOW_S},v0=${digest}ab`, body)).toEqual({ ok: false, reason: "malformed_header" });
  });

  test("rejects a non-integer timestamp", () => {
    for (const t of ["", "abc", "1.5", "-5", "1e9", "0x10", "1800000000abc"]) {
      expect(verify(sign(body, t), body)).toEqual({ ok: false, reason: "invalid_timestamp" });
    }
  });

  test("rejects a wrong secret and a digest of another timestamp", () => {
    expect(verify(sign(body, NOW_S, "another"), body)).toEqual({ ok: false, reason: "digest_mismatch" });
    const stale = sign(body, NOW_S - 1);
    expect(verify(stale.replace(`t=${NOW_S - 1}`, `t=${NOW_S}`), body)).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  test("rejects a delivery older than 30 minutes and accepts one just inside", () => {
    expect(verify(sign(body, NOW_S - 30 * 60 - 1), body)).toEqual({ ok: false, reason: "expired" });
    expect(verify(sign(body, NOW_S - 30 * 60), body)).toEqual({ ok: true });
  });

  test("rejects a timestamp more than 5 minutes ahead and accepts modest skew", () => {
    expect(verify(sign(body, NOW_S + 5 * 60 + 1), body)).toEqual({ ok: false, reason: "future" });
    expect(verify(sign(body, NOW_S + 5 * 60), body)).toEqual({ ok: true });
  });

  test("a duplicate delivery verifies identically (idempotence is the settlement's job)", () => {
    const header = sign(body);
    expect(verify(header, body)).toEqual({ ok: true });
    expect(verify(header, body, NOW_MS + 1000)).toEqual({ ok: true });
  });

  test("a large body verifies", () => {
    const big = encoder.encode(`{"pad":"${"x".repeat(20 * 1024 * 1024)}"}`);
    expect(verify(sign(big), big)).toEqual({ ok: true });
  });
});
