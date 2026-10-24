import { describe, expect, test } from "bun:test";
import { postingScheduleSchema, sortedPostingSchedule, POSTING_SCHEDULE_MAX_SLOTS } from "./posting-schedule";
import { acceptSocialPostProposalSchema, proposeSocialPostSchema } from "./publishing-queue";
import { WORKSPACE_EVENT_PUBLISHING_TYPES, workspaceEventSchema } from "./workspace-event";

const id = "00000000-0000-4000-8000-000000000001";

describe("posting schedule", () => {
  test("accepts weekly slots as a weekday and 24-hour local time", () => {
    expect(postingScheduleSchema.parse({ slots: [{ weekday: "mon", time: "09:00" }, { weekday: "sun", time: "23:59" }] }).slots).toHaveLength(2);
    expect(postingScheduleSchema.safeParse({ slots: [] }).success).toBe(true);
  });

  test("refuses anything that is not a real slot", () => {
    for (const invalid of [
      { slots: [{ weekday: "monday", time: "09:00" }] },
      { slots: [{ weekday: "mon", time: "9:00" }] },
      { slots: [{ weekday: "mon", time: "24:00" }] },
      { slots: [{ weekday: "mon", time: "09:60" }] },
      { slots: [{ weekday: "mon", time: "09:00" }, { weekday: "mon", time: "09:00" }] },
      { slots: [{ weekday: "mon", time: "09:00", note: "x" }] },
      { slots: Array.from({ length: POSTING_SCHEDULE_MAX_SLOTS + 1 }, (_, index) => ({ weekday: "tue", time: `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}` })) },
      {},
    ]) {
      expect(postingScheduleSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test("keeps slots in week order however they were entered", () => {
    const sorted = sortedPostingSchedule({ slots: [{ weekday: "sun", time: "08:00" }, { weekday: "mon", time: "18:30" }, { weekday: "mon", time: "09:00" }] });
    expect(sorted.slots.map((slot) => `${slot.weekday} ${slot.time}`)).toEqual(["mon 09:00", "mon 18:30", "sun 08:00"]);
  });
});

describe("queue proposals", () => {
  test("a proposal names a clip, a finished export and an account; the caption is optional", () => {
    expect(proposeSocialPostSchema.parse({ clipId: id, exportId: id, socialAccountId: id })).toEqual({ clipId: id, exportId: id, socialAccountId: id });
    expect(proposeSocialPostSchema.parse({ clipId: id, exportId: id, socialAccountId: id, caption: "  Hello  " }).caption).toBe("Hello");
    for (const invalid of [{ clipId: id, exportId: id }, { clipId: id, exportId: id, socialAccountId: id, scheduledFor: "2030-01-01T00:00:00Z" }, { clipId: id, exportId: id, socialAccountId: id, caption: "x".repeat(5_001) }]) {
      expect(proposeSocialPostSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test("accepting takes TikTok's per-post choices and nothing else", () => {
    expect(acceptSocialPostProposalSchema.parse({})).toEqual({});
    expect(acceptSocialPostProposalSchema.parse({ tiktok: { deliveryMode: "direct", privacyLevel: "SELF_ONLY" } }).tiktok).toMatchObject({
      deliveryMode: "direct", privacyLevel: "SELF_ONLY", disableComment: false, disableDuet: false, disableStitch: false, isAigc: false,
    });
    expect(acceptSocialPostProposalSchema.safeParse({ tiktok: { deliveryMode: "later" } }).success).toBe(false);
    expect(acceptSocialPostProposalSchema.safeParse({ scheduledFor: "2030-01-01T00:00:00Z" }).success).toBe(false);
  });

  test("social_post.proposed is a versioned event that needs the publishing scope", () => {
    expect(WORKSPACE_EVENT_PUBLISHING_TYPES).toContain("social_post.proposed");
    const subject = { socialPostId: id, projectId: id, clipId: id, socialAccountId: id, platform: "tiktok" };
    const event = { id, seq: 1, type: "social_post.proposed", version: 1, occurredAt: "2026-10-24T12:00:00.000Z", subject };
    expect(workspaceEventSchema.safeParse(event).success).toBe(true);
    expect(workspaceEventSchema.safeParse({ ...event, subject: { ...subject, caption: "no" } }).success).toBe(false);
  });
});
