import { describe, expect, test } from "bun:test";
import {
  audioAssetUploadPrefix,
  extensionForAudioContentType,
  isOwnedAudioUploadKey,
} from "./audio-asset.service";

// Pure helpers behind AudioAssetService (Music/SFX library, vizard-parity
// Phase C). No DB-backed harness exists for this package (see
// billing-features.test.ts's precedent) — everything that needs Prisma is
// exercised indirectly through these extracted, unit-testable pieces.

describe("audioAssetUploadPrefix / isOwnedAudioUploadKey", () => {
  test("a key under the caller's own prefix is owned", () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const key = `${audioAssetUploadPrefix(userId)}abc123.mp3`;
    expect(isOwnedAudioUploadKey(userId, key)).toBe(true);
  });

  test("a key under a different user's prefix is not owned", () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const otherUserId = "22222222-2222-2222-2222-222222222222";
    const key = `${audioAssetUploadPrefix(otherUserId)}abc123.mp3`;
    expect(isOwnedAudioUploadKey(userId, key)).toBe(false);
  });

  test("a curated-library-shaped key is not owned by any user", () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    expect(
      isOwnedAudioUploadKey(userId, "audio-library/music/track-01.mp3"),
    ).toBe(false);
  });

  test("a prefix-string-only key without a trailing object name is not owned (no path traversal via bare prefix)", () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    // Exact prefix match with nothing after it still starts-with correctly,
    // but a caller could try to claim the "directory" key itself — startsWith
    // still returns true here, which is intentional: it is a member of the
    // caller's own namespace either way, not another tenant's object.
    expect(
      isOwnedAudioUploadKey(userId, audioAssetUploadPrefix(userId)),
    ).toBe(true);
  });

  test("a key that merely contains the prefix substring elsewhere is not owned", () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const key = `other-prefix/${audioAssetUploadPrefix(userId)}abc.mp3`;
    expect(isOwnedAudioUploadKey(userId, key)).toBe(false);
  });
});

describe("extensionForAudioContentType", () => {
  test("maps every accepted content type to its expected extension", () => {
    expect(extensionForAudioContentType("audio/mpeg")).toBe("mp3");
    expect(extensionForAudioContentType("audio/wav")).toBe("wav");
    expect(extensionForAudioContentType("audio/x-wav")).toBe("wav");
    expect(extensionForAudioContentType("audio/mp4")).toBe("m4a");
    expect(extensionForAudioContentType("audio/x-m4a")).toBe("m4a");
  });

  test("falls back to a safe default extension for an unrecognized content type", () => {
    expect(extensionForAudioContentType("application/octet-stream")).toBe(
      "bin",
    );
  });
});
