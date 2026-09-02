import { describe, expect, test } from "bun:test";
import { buildReviewCommentPayload, reviewApprovalProgress } from "./review-client-model";

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
