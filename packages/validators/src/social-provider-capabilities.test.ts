import { describe, expect, test } from "bun:test";
import { scheduleSocialPostSchema } from "./social";
import {
  SOCIAL_PROVIDER_CAPABILITIES,
  socialProviderAcceptsCustomThumbnail,
  socialProviderAcceptsMedia,
} from "./social-provider-capabilities";

const request = {
  clientIdempotencyKey: "8ab9d330-688f-4574-932c-27ac661245c1",
  clipId: "d8ab95f8-fc16-4e60-814e-69762a59a99b",
  expectedEditorRevision: 1,
  accountId: "a3196d76-b71d-4b93-8812-7435b9e17faf",
  platform: "facebook_reels" as const,
  caption: "Approved copy",
  aspectRatio: "9:16" as const,
  resolution: "1080p" as const,
  scheduledFor: "2026-09-01T12:00:00.000Z",
  providerSettings: {},
};

describe("social provider capability contract", () => {
  test("carries an explicit immutable validation version for every provider", () => {
    expect(Object.values(SOCIAL_PROVIDER_CAPABILITIES).every((capability) => capability.version.length > 0)).toBe(true);
    expect({
      youtube: SOCIAL_PROVIDER_CAPABILITIES.youtube_shorts.version,
      instagram: SOCIAL_PROVIDER_CAPABILITIES.instagram_reels.version,
      tiktok: SOCIAL_PROVIDER_CAPABILITIES.tiktok.version,
    }).toEqual({
      youtube: "youtube-shorts-v2",
      instagram: "instagram-reels-v2",
      tiktok: "tiktok-v3",
    });
  });

  test("rejects unsupported thumbnails and aspect ratios at the direct API boundary", () => {
    expect(scheduleSocialPostSchema.safeParse({ ...request, providerSettings: { thumbnailType: "custom_image" } }).success).toBe(false);
		expect(scheduleSocialPostSchema.safeParse({ ...request, providerSettings: { thumbnailType: "video_frame" } }).success).toBe(false);
    expect(scheduleSocialPostSchema.safeParse({ ...request, aspectRatio: "16:9" }).success).toBe(false);
  });

  test("keeps exact video frames optional when the provider has a native first-frame default", () => {
    for (const platform of ["instagram_reels", "tiktok"] as const) {
      expect(SOCIAL_PROVIDER_CAPABILITIES[platform].thumbnailTypes).toEqual([
        "provider_default",
        "video_frame",
      ]);
      expect(scheduleSocialPostSchema.safeParse({
        ...request,
        platform,
        providerSettings: { thumbnailType: "provider_default" },
      }).success).toBe(true);
    }
  });

  test("uses provider-specific text and media limits without a second narrower validator", () => {
    expect(scheduleSocialPostSchema.safeParse({ ...request, platform: "youtube_shorts", caption: "x".repeat(4_000), aspectRatio: "9:16", providerSettings: { thumbnailType: "custom_image" } }).success).toBe(true);
    expect(socialProviderAcceptsMedia({ platform: "youtube_shorts", aspectRatio: "16:9", durationSec: 30 })).toBe(false);
    expect(socialProviderAcceptsMedia({ platform: "youtube_shorts", aspectRatio: "9:16", durationSec: 180 })).toBe(true);
    expect(socialProviderAcceptsMedia({ platform: "youtube_shorts", aspectRatio: "1:1", durationSec: 180.01 })).toBe(false);
    expect(scheduleSocialPostSchema.safeParse({ ...request, platform: "x", caption: "x".repeat(281), aspectRatio: "16:9", providerSettings: { thumbnailType: "provider_default" } }).success).toBe(false);
    expect(socialProviderAcceptsMedia({ platform: "facebook_reels", aspectRatio: "9:16", durationSec: 3.99 })).toBe(false);
    expect(socialProviderAcceptsMedia({ platform: "facebook_reels", aspectRatio: "9:16", durationSec: 4 })).toBe(true);
    expect(socialProviderAcceptsMedia({ platform: "facebook_reels", aspectRatio: "9:16", durationSec: 60 })).toBe(true);
    expect(socialProviderAcceptsMedia({ platform: "facebook_reels", aspectRatio: "9:16", durationSec: 60.01 })).toBe(false);
    expect(SOCIAL_PROVIDER_CAPABILITIES.facebook_reels.publishingEnabledByDefault).toBe(false);
		expect(SOCIAL_PROVIDER_CAPABILITIES.facebook_reels.providerPolling).toBe(true);
		expect(Object.values(SOCIAL_PROVIDER_CAPABILITIES).every((capability) =>
			typeof capability.titleField === "boolean" && typeof capability.firstCommentField === "boolean"
		)).toBe(true);
  });

  test("keeps custom-thumbnail object constraints in the shared provider contract", () => {
    expect(socialProviderAcceptsCustomThumbnail({
      platform: "youtube_shorts",
      contentType: "image/png",
      sizeBytes: 2 * 1024 * 1024,
    })).toBe(true);
    expect(socialProviderAcceptsCustomThumbnail({
      platform: "youtube_shorts",
      contentType: "image/webp",
      sizeBytes: 100,
    })).toBe(false);
    expect(socialProviderAcceptsCustomThumbnail({
      platform: "youtube_shorts",
      contentType: "image/jpeg",
      sizeBytes: 2 * 1024 * 1024 + 1,
    })).toBe(false);
    expect(socialProviderAcceptsCustomThumbnail({
      platform: "facebook_reels",
      contentType: "image/jpeg",
      sizeBytes: 100,
    })).toBe(false);
  });
});
