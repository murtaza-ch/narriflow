import { describe, expect, test } from "bun:test";
import {
  createReviewRoundAutomationSchema,
  createReviewRoundSchema,
  internalReviewCommentSchema,
  reviewApprovalOverrideSchema,
  reviewRoundCreateResponseSchema,
} from "./review";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("review workflow inputs", () => {
  test("accepts only internally consistent review-round creation responses", () => {
    const token = "a".repeat(43);
    const response = {
      id: id(20),
      revision: 1,
      createdAt: "2026-08-31T12:00:00.000Z",
      token,
      path: `/review/${token}`,
      notificationIds: [id(21)],
      replayed: false,
      delivery: [
        {
          status: "sent",
          notificationId: id(21),
          failureCode: null,
        },
      ],
    };

    expect(reviewRoundCreateResponseSchema.safeParse(response).success).toBe(true);
    expect(
      reviewRoundCreateResponseSchema.safeParse({
        ...response,
        path: "/review/a-different-token",
      }).success,
    ).toBe(false);
  });

  test("normalizes bounded recipients and resubmission lineage", () => {
    const parsed = createReviewRoundSchema.parse({
      title: "  Client cut  ",
      recipientEmails: ["  client@example.test  "],
      sourceRoundId: id(1),
      items: [{
        clipId: id(2),
        exportId: id(3),
        expectedEditorRevision: 4,
        variantIds: [id(5)],
      }],
    });

    expect(parsed.title).toBe("Client cut");
    expect(parsed.recipientEmails).toEqual(["client@example.test"]);
    expect(parsed.sourceRoundId).toBe(id(1));
    expect(parsed.approvalRequired).toBeUndefined();
  });

  test("requires a caller idempotency key for automation round creation", () => {
    const request = {
      idempotencyKey: id(9),
      title: "Client cut",
      items: [{
        clipId: id(2),
        exportId: id(3),
        expectedEditorRevision: 4,
        variantIds: [id(5)],
      }],
    };
    expect(createReviewRoundAutomationSchema.parse(request).idempotencyKey).toBe(id(9));
    expect(
      createReviewRoundAutomationSchema.safeParse({
        ...request,
        idempotencyKey: undefined,
      }).success,
    ).toBe(false);
  });

  test("keeps internal mentions explicit instead of parsing comment text", () => {
    expect(internalReviewCommentSchema.parse({
      itemId: id(1),
      parentId: null,
      body: "Please check the closing frame.",
      timestampSec: 8.25,
      mentionRecipientIds: [id(2)],
    }).mentionRecipientIds).toEqual([id(2)]);

    expect(() => internalReviewCommentSchema.parse({
      itemId: null,
      parentId: null,
      body: "Hello",
      timestampSec: null,
      mentionRecipientIds: Array.from({ length: 11 }, (_, index) => id(index + 1)),
    })).toThrow();
  });

  test("requires a bounded nonempty reason for exact-export overrides", () => {
    expect(reviewApprovalOverrideSchema.parse({
      idempotencyKey: id(1),
      exportIds: [id(2)],
      reason: "Client approved by phone after the final export.",
    }).reason).toBe("Client approved by phone after the final export.");

    expect(() => reviewApprovalOverrideSchema.parse({
      idempotencyKey: id(1),
      exportIds: [id(2)],
      reason: "   ",
    })).toThrow();
  });
});
