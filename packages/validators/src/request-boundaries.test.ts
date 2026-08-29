import { describe, expect, test } from "bun:test";
import { finalizeAudioUploadSchema, presignAudioUploadSchema } from "./audio-asset";
import { autopilotRuleInputSchema } from "./autopilot";
import { rssPreviewSchema } from "./ingest";
import { linkIngestSchema } from "./link-providers";
import { scheduleSocialPostSchema, socialPostMetricsSchema } from "./social";

const forged = { workspaceId: "forged", ownerUserId: "forged", storageKey: "forged" };
const linkInput = { url: "https://youtube.com/watch?v=abc" };
const rssInput = { rssUrl: "https://feeds.example/show.xml" };
const audioPresignInput = { contentType: "audio/mpeg", sizeBytes: 1024 } as const;
const audioFinalizeInput = {
  key: "audio/owned-key",
  kind: "music",
  title: "Intro",
} as const;
const autopilotInput = {
  name: "Show",
  rssUrl: "https://feeds.example/show.xml",
  contentPack: {
    outputTypes: ["short_clip"],
    clipCountTarget: 3,
    clipDurationSecTarget: 45,
    platformPlaybookVersion: "2026.2",
  },
};
const socialScheduleInput = {
  clientIdempotencyKey: "4ac4e6ad-9f29-4cb2-a9ea-35ec85efc332",
  clipId: "32acc9f1-0c74-41f1-b2df-627f1bbb2eff",
  expectedEditorRevision: 1,
  accountId: null,
  platform: "linkedin",
  caption: "Caption",
  aspectRatio: "9:16",
  resolution: "1080p",
  scheduledFor: "2026-08-29T10:00:00.000Z",
};

describe("browser request schemas", () => {
  test("reject infrastructure and ownership fields at ingest and audio boundaries", () => {
    expect(linkIngestSchema.safeParse(linkInput).success).toBe(true);
    expect(rssPreviewSchema.safeParse(rssInput).success).toBe(true);
    expect(presignAudioUploadSchema.safeParse(audioPresignInput).success).toBe(true);
    expect(finalizeAudioUploadSchema.safeParse(audioFinalizeInput).success).toBe(true);
    expect(
      linkIngestSchema.safeParse({ ...linkInput, ...forged })
        .success,
    ).toBe(false);
    expect(
      rssPreviewSchema.safeParse({ ...rssInput, ...forged })
        .success,
    ).toBe(false);
    expect(
      presignAudioUploadSchema.safeParse({ ...audioPresignInput, ...forged }).success,
    ).toBe(false);
    expect(
      finalizeAudioUploadSchema.safeParse({ ...audioFinalizeInput, ...forged }).success,
    ).toBe(false);
  });

  test("rejects unknown fields at automation and publication boundaries", () => {
    expect(autopilotRuleInputSchema.safeParse(autopilotInput).success).toBe(true);
    expect(scheduleSocialPostSchema.safeParse(socialScheduleInput).success).toBe(true);
    expect(socialPostMetricsSchema.safeParse({ views: 1 }).success).toBe(true);
    expect(
      autopilotRuleInputSchema.safeParse({ ...autopilotInput, ...forged }).success,
    ).toBe(false);
    expect(
      scheduleSocialPostSchema.safeParse({ ...socialScheduleInput, ...forged }).success,
    ).toBe(false);
    expect(
      socialPostMetricsSchema.safeParse({ views: 1, ...forged }).success,
    ).toBe(false);
  });
});
