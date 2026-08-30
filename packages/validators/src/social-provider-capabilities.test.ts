import { describe, expect, test } from "bun:test";
import { scheduleSocialPostSchema } from "./social";
import { SOCIAL_PROVIDER_CAPABILITIES, socialProviderAcceptsMedia } from "./social-provider-capabilities";

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
  });

  test("rejects unsupported thumbnails and aspect ratios at the direct API boundary", () => {
    expect(scheduleSocialPostSchema.safeParse({ ...request, providerSettings: { thumbnailType: "custom_image" } }).success).toBe(false);
    expect(scheduleSocialPostSchema.safeParse({ ...request, aspectRatio: "16:9" }).success).toBe(false);
  });

  test("uses provider-specific text and media limits without a second narrower validator", () => {
    expect(scheduleSocialPostSchema.safeParse({ ...request, platform: "youtube_shorts", caption: "x".repeat(4_000), aspectRatio: "16:9", providerSettings: { thumbnailType: "custom_image" } }).success).toBe(true);
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
});
