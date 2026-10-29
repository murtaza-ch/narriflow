import { describe, expect, test } from "bun:test";
import { buildReviewCommentPayload, reviewApprovalProgress, reviewSessionKey, readReviewSession, grantRefreshDelay } from "./review-client-model";

describe("guest review browser behavior", () => {
  test("submits clip feedback at the current playhead", () => {
    expect(buildReviewCommentPayload({
      body: "  Tighten this beat.  ",
      activeItemId: "item-1",
      parent: null,
      scope: "clip",
      includeTimecode: true,
      currentTimeSec: 12.75,
    })).toEqual({
      itemId: "item-1",
      parentId: null,
      body: "Tighten this beat.",
      timestampSec: 12.75,
    });
  });

  test("submits general feedback without attaching a clip or playhead", () => {
    expect(buildReviewCommentPayload({
      body: "The campaign tone is right.",
      activeItemId: "item-1",
      parent: null,
      scope: "round",
      includeTimecode: true,
      currentTimeSec: 12.75,
    })).toEqual({
      itemId: null,
      parentId: null,
      body: "The campaign tone is right.",
      timestampSec: null,
    });
  });

  test("keeps replies in their parent thread and removes a new playhead", () => {
    expect(buildReviewCommentPayload({
      body: "That works for me.",
      activeItemId: "item-2",
      parent: { id: "comment-1", itemId: "item-1" },
      scope: "clip",
      includeTimecode: true,
      currentTimeSec: 24,
    })).toMatchObject({ itemId: "item-1", parentId: "comment-1", timestampSec: null });
  });

  test("gates round approval on every required item", () => {
    expect(reviewApprovalProgress([
      { required: true, currentDecision: "approved" },
      { required: true, currentDecision: null },
      { required: false, currentDecision: null },
    ], true)).toEqual({ approved: 1, required: 2, ready: false });
    expect(reviewApprovalProgress([
      { required: true, currentDecision: "approved" },
      { required: true, currentDecision: "approved" },
    ], true).ready).toBe(true);
  });
});


describe("review credential and grant lifetime", () => {
  const digest = "a".repeat(64);
  test("tab storage uses only the token digest and removes expired or malformed credentials", () => {
    const rows = new Map<string, string>();
    const storage = { getItem: (key: string) => rows.get(key) ?? null, removeItem: (key: string) => { rows.delete(key); } };
    const key = reviewSessionKey(digest);
    expect(key).toBe(`nf-review-session:${digest}`);
    expect(() => reviewSessionKey("raw-review-token")).toThrow();
    const session = { sessionToken: "guest-bearer", expiresAt: "2026-10-29T12:00:00.000Z" };
    rows.set(key, JSON.stringify(session));
    expect(readReviewSession(storage, digest, Date.parse(session.expiresAt) - 1)).toEqual(session);
    expect(readReviewSession(storage, digest, Date.parse(session.expiresAt))).toBeNull();
    expect(rows.has(key)).toBe(false);
    rows.set(key, '{"sessionToken":"credential","expiresAt":"invalid"}');
    expect(readReviewSession(storage, digest)).toBeNull();
    expect(rows.has(key)).toBe(false);
  });
  test("renews media five seconds before expiry, including already expired grants", () => {
    const now = Date.parse("2026-10-29T12:00:00.000Z");
    expect(grantRefreshDelay(new Date(now + 60_000).toISOString(), now)).toBe(55_000);
    expect(grantRefreshDelay(new Date(now - 1).toISOString(), now)).toBe(0);
  });
});
