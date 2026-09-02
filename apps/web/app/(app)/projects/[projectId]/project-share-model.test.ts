import { describe, expect, test } from "bun:test";
import {
  activeShareRound,
  buildQuickReviewRoundInput,
  invalidReviewerEmails,
  reviewerEmailsFromText,
  reviewApprovalProgress,
} from "./project-share-model";
import type { ReviewRoomData } from "./review-panel";

const data = {
  project: {
    title: "Launch film",
    workspace: { name: "Acme" },
    approvalRequiredByDefault: true,
  },
  candidates: [{
    id: "clip-1",
    title: "Opening",
    editorRevision: 4,
    exports: [{
      id: "export-1",
      editorRevision: 4,
      createdAt: "2026-09-02T00:00:00.000Z",
      variants: [
        { id: "variant-1", aspectRatio: "ratio_9_16", durationSec: 20 },
        { id: "variant-2", aspectRatio: "ratio_1_1", durationSec: 20 },
      ],
    }],
  }],
  rounds: [],
} satisfies ReviewRoomData;

describe("project share model", () => {
  test("normalizes reviewer emails and reports invalid entries", () => {
    expect(reviewerEmailsFromText(" Client@Example.com;client@example.com team@example.com "))
      .toEqual(["client@example.com", "team@example.com"]);
    expect(invalidReviewerEmails("client@example.com, nope"))
      .toEqual(["nope"]);
  });

  test("builds the zero-configuration round from every latest ready export", () => {
    expect(buildQuickReviewRoundInput(data, ["client@example.com"])).toEqual({
      title: "Launch film review",
      message: null,
      passcode: null,
      expiresAt: null,
      allowDownloads: false,
      approvalRequired: true,
      recipientEmails: ["client@example.com"],
      contextCommentIds: [],
      items: [{
        clipId: "clip-1",
        exportId: "export-1",
        expectedEditorRevision: 4,
        variantIds: ["variant-1", "variant-2"],
        required: true,
      }],
    });
  });

  test("chooses the latest live round and counts exact approvals", () => {
    const round = {
      id: "round-live",
      revision: 3,
      title: "Round 3",
      message: null,
      status: "open",
      path: "/review/token",
      allowDownloads: false,
      approvalRequired: true,
      recipientEmails: [],
      sentAt: "2026-09-02T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      decision: null,
      newerWorkAvailable: false,
      items: [
        { id: "item-1", clipId: "clip-1", clipTitle: "A", exportId: "export-1", editorRevision: 1, required: true, currentDecision: "approved", variants: [] },
        { id: "item-2", clipId: "clip-2", clipTitle: "B", exportId: "export-2", editorRevision: 1, required: true, currentDecision: null, variants: [] },
      ],
      comments: [],
      guests: [],
      auditEvents: [],
      notifications: [],
      context: [],
    };
    const expired = { ...round, id: "round-old", status: "expired", path: "/review/old" };
    const room = { ...data, rounds: [expired, round] } satisfies ReviewRoomData;
    expect(activeShareRound(room)?.id).toBe("round-live");
    expect(reviewApprovalProgress(round)).toEqual({ approved: 1, required: 2 });
  });
});
