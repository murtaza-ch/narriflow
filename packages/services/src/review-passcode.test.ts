import { describe, expect, test } from "bun:test";
import { hashReviewPasscode, verifyReviewPasscode } from "./review-passcode";

describe("review passcode derivation", () => {
  test("verifies the independent Python hashlib PBKDF2-HMAC-SHA256 600k vector", async () => {
    const encoded = "pbkdf2-sha256$600000$07070707070707070707070707070707$0a039aa11ff5f0a0aef526fb013167915820bf7154750855c05fab53d04c407d";
    expect(await verifyReviewPasscode("narriflow-protocol-test", encoded)).toBe(true);
  });
  test("rejects noncurrent formats and unbounded inputs before derivation", async () => {
    for (const encoded of ["$argon2id$v=19$removed", "pbkdf2-sha256$100000$00$00", "pbkdf2-sha256$999999999$00$00", "invalid"]) {
      expect(await verifyReviewPasscode("password", encoded)).toBe(false);
    }
    await expect(hashReviewPasscode("")).rejects.toThrow(RangeError);
    await expect(hashReviewPasscode("a".repeat(129))).rejects.toThrow(RangeError);
    expect(await verifyReviewPasscode("a".repeat(129), "invalid")).toBe(false);
  });
});
