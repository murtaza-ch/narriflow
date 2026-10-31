import { describe, expect, test } from "bun:test";
import { ThumbnailPreparationError, validateThumbnailSelection, validateProviderThumbnailAsset } from "./thumbnail-frame-preparation";

describe("provider thumbnail capabilities", () => {
  test("rejects unsupported thumbnail sources at the shared capability boundary", () => {
    expect(() => validateThumbnailSelection({
      platform: "x",
      selection: {
        assetId: "00000000-0000-4000-8000-000000000099",
        fingerprint: "b".repeat(64),
        source: "uploaded",
        sourceTimeMs: null,
      },
    })).toThrow(ThumbnailPreparationError);

    expect(validateThumbnailSelection({
      platform: "youtube_shorts",
      selection: {
        assetId: "00000000-0000-4000-8000-000000000099",
        fingerprint: "b".repeat(64),
        source: "generated",
        sourceTimeMs: null,
      },
    })).toMatchObject({ thumbnailType: "custom_image" });
    expect(validateThumbnailSelection({
      platform: "tiktok",
      selection: {
        assetId: "00000000-0000-4000-8000-000000000099",
        fingerprint: "b".repeat(64),
        source: "extracted_frame",
        sourceTimeMs: 2_500,
      },
    })).toMatchObject({ thumbnailType: "video_frame", videoCoverTimestampMs: 2_500 });
  });

  test("rejects YouTube thumbnail files that its API cannot accept", () => {
    expect(() => validateProviderThumbnailAsset({
      platform: "youtube_shorts",
      contentType: "image/webp",
      sizeBytes: 100n,
    })).toThrow(expect.objectContaining({ code: "thumbnail_provider_constraint" }));
    expect(() => validateProviderThumbnailAsset({
      platform: "youtube_shorts",
      contentType: "image/png",
      sizeBytes: 2_000_001n,
    })).toThrow(expect.objectContaining({ code: "thumbnail_provider_constraint" }));
    expect(() => validateProviderThumbnailAsset({
      platform: "youtube_shorts",
      contentType: "image/jpeg",
      sizeBytes: 2_000_000n,
    })).not.toThrow();
  });
});
