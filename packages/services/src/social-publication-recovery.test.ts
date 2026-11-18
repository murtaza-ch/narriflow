import { describe, expect, test } from "bun:test";
import {
  allowedSocialPublicationActions,
  replacementAttemptData,
  retryStartsFirstAttempt,
  socialPublicationReconnectRequired,
  validateSocialPublicationEvidence,
} from "./social-publication-recovery";
import { parseSocialPublicationAttemptBudget } from "./social-publication-config";

const owner = { role: "owner", status: "active" } as const;
const admin = { role: "admin", status: "active" } as const;
const editor = { role: "editor", status: "active" } as const;
const viewer = { role: "viewer", status: "active" } as const;

describe("Social Publication recovery actions", () => {
  test("offers only safe actions for each terminal projection", () => {
    expect(
      allowedSocialPublicationActions({
        status: "needs_attention",
        errorCode: "publication_outcome_unknown",
        workspace: { status: "active" },
        socialAccount: { status: "active" },
      }, owner),
    ).toEqual(["recheck", "confirm_published", "publish_again"]);
    expect(
      allowedSocialPublicationActions({
        status: "failed",
        errorCode: "x_post_failed",
      }, owner),
    ).toEqual(["schedule_again"]);
  });

  const failedAt = new Date("2026-11-05T20:00:00Z");
  const before = new Date("2026-11-05T19:00:00Z");
  const after = new Date("2026-11-05T21:00:00Z");
  const failedPost = (errorCode: string, accountUpdatedAt: Date, status = "active") => ({
    status: "failed",
    errorCode,
    updatedAt: failedAt,
    workspace: { status: "active" },
    socialAccount: { status, updatedAt: accountUpdatedAt },
  });

  test("a definite failure can be tried again on the same post", () => {
    expect(allowedSocialPublicationActions(failedPost("tiktok_publish_failed", before), owner))
      .toEqual(["retry", "schedule_again"]);
  });

  test("a failure that names the account asks for a reconnect only until the account changes", () => {
    for (const code of ["tiktok_permission_required", "tiktok_authentication_required"]) {
      expect(allowedSocialPublicationActions(failedPost(code, before), owner)).toEqual(["reconnect_account"]);
      expect(socialPublicationReconnectRequired(failedPost(code, before))).toBe(true);
      expect(allowedSocialPublicationActions(failedPost(code, after), owner)).toEqual(["retry", "schedule_again"]);
      expect(socialPublicationReconnectRequired(failedPost(code, after))).toBe(false);
    }
  });

  test("an account that is not active still needs a reconnect, however recently it changed", () => {
    expect(allowedSocialPublicationActions(failedPost("tiktok_publish_failed", after, "expired"), owner))
      .toEqual(["reconnect_account"]);
  });

  test("a failure tied to what was frozen offers only a new post, because a retry repeats it", () => {
    for (const code of [
      "tiktok_privacy_setting_changed",
      "tiktok_creator_setting_changed",
      "tiktok_creator_account_changed",
      "tiktok_publication_invalid",
      "publication_frozen_media_missing",
      "publication_capability_version_mismatch",
    ]) {
      expect(allowedSocialPublicationActions(failedPost(code, after), owner)).toEqual(["schedule_again"]);
    }
  });

  test("a restricted workspace cannot try again", () => {
    expect(allowedSocialPublicationActions({
      ...failedPost("tiktok_publish_failed", before),
      workspace: { status: "restricted" },
    }, owner)).toEqual(["schedule_again"]);
  });

  test("workspace restriction and account revocation stop new provider work", () => {
    expect(
      allowedSocialPublicationActions({
        status: "needs_attention",
        errorCode: "publication_outcome_unknown",
        workspace: { status: "restricted" },
        socialAccount: { status: "active" },
      }, owner),
    ).toEqual(["recheck", "confirm_published"]);
    expect(
      allowedSocialPublicationActions({
        status: "needs_attention",
        errorCode: "publication_outcome_unknown",
        workspace: { status: "active" },
        socialAccount: { status: "revoked" },
      }, owner),
    ).toEqual(["confirm_published", "reconnect_account"]);
  });

  const revokedAccount = {
    status: "needs_attention",
    errorCode: "publication_outcome_unknown",
    workspace: { status: "active" },
    socialAccount: { status: "revoked" },
  };

  test("viewers get no actions", () => {
    expect(allowedSocialPublicationActions(revokedAccount, viewer)).toEqual([]);
    expect(
      allowedSocialPublicationActions({ status: "scheduled", errorCode: null }, viewer),
    ).toEqual([]);
  });

  test("editors manage posts but never reconnect an account", () => {
    expect(allowedSocialPublicationActions(revokedAccount, editor)).toEqual([
      "confirm_published",
    ]);
    expect(
      allowedSocialPublicationActions(
        { status: "failed", errorCode: "social_account_reconnect_required" },
        editor,
      ),
    ).toEqual([]);
    expect(
      allowedSocialPublicationActions({ status: "scheduled", errorCode: null }, editor),
    ).toEqual(["cancel"]);
  });

  test("owners and admins may reconnect", () => {
    for (const actor of [owner, admin]) {
      expect(allowedSocialPublicationActions(revokedAccount, actor)).toEqual([
        "confirm_published",
        "reconnect_account",
      ]);
    }
  });

  test("a restricted workspace stops even the owner's post actions", () => {
    expect(
      allowedSocialPublicationActions(revokedAccount, { role: "owner", status: "restricted" }),
    ).toEqual([]);
  });

  test("reconnectRequired is independent of the member's role", () => {
    expect(socialPublicationReconnectRequired(revokedAccount)).toBe(true);
    expect(
      socialPublicationReconnectRequired({ status: "scheduled", errorCode: null }),
    ).toBe(false);
  });

  test("validates ownership only after an authenticated provider lookup", async () => {
    expect(
      await validateSocialPublicationEvidence({
        platform: "x",
        externalUrl: "https://x.com/Creator/status/123",
        accountHandle: "@creator",
        accessToken: "access-token",
        scopes: ["tweet.read", "users.read"],
        validateOwnership: true,
        request: async () =>
          Response.json({
            data: { id: "123", author_id: "owner-1" },
            includes: { users: [{ id: "owner-1", username: "creator" }] },
          }),
      }),
    ).toEqual({
      externalUrl: "https://x.com/Creator/status/123",
      ownershipValidated: true,
    });
    expect(
      (await validateSocialPublicationEvidence({
        platform: "tiktok",
        externalUrl: "https://www.tiktok.com/@creator/video/123",
        accountHandle: "creator",
        validateOwnership: true,
      })).ownershipValidated,
    ).toBe(false);
  });

  test("rejects evidence owned by another account and records opaque URLs as unvalidated", async () => {
    expect(
      validateSocialPublicationEvidence({
        platform: "x",
        externalUrl: "https://x.com/someone_else/status/123",
        accountHandle: "creator",
      }),
    ).rejects.toThrow("does not belong to the selected social account");
    expect(
      (await validateSocialPublicationEvidence({
        platform: "youtube_shorts",
        externalUrl: "https://youtube.com/shorts/123",
        accountHandle: "creator",
      })).ownershipValidated,
    ).toBe(false);
  });

  test("rejects profile URLs that do not identify a publication", async () => {
    expect(
      validateSocialPublicationEvidence({
        platform: "x",
        externalUrl: "https://x.com/creator",
        accountHandle: "creator",
      }),
    ).rejects.toThrow("must identify one post");
  });
});

describe("Try again for a post that failed before any attempt existed", () => {
  const failedAt = new Date("2026-11-18T08:00:00Z");
  const reconnectedAt = new Date("2026-11-18T08:15:00Z");
  const failedByDeadConnection = {
    status: "failed",
    errorCode: "social_account_reconnect_required",
    updatedAt: failedAt,
    workspace: { status: "active" },
    socialAccount: { status: "active", updatedAt: reconnectedAt },
  };

  test("offers Try again once the account has been reconnected, whatever attempts the post has", () => {
    expect(allowedSocialPublicationActions(failedByDeadConnection, owner)).toEqual(["retry", "schedule_again"]);
    expect(allowedSocialPublicationActions(failedByDeadConnection, editor)).toEqual(["retry", "schedule_again"]);
  });

  test("keeps offering reconnect until the account is back", () => {
    expect(allowedSocialPublicationActions({ ...failedByDeadConnection, socialAccount: { status: "expired", updatedAt: failedAt } }, owner)).toEqual(["reconnect_account"]);
  });

  test("a failed post with no attempt starts its first attempt; one with an attempt keeps the replacement path", () => {
    expect(retryStartsFirstAttempt({ status: "failed" }, undefined, "failed")).toBe(true);
    expect(retryStartsFirstAttempt({ status: "failed" }, { phase: "failed" }, "failed")).toBe(false);
  });

  test("only a failed post qualifies: Publish again still needs the attempt whose outcome was unknown", () => {
    expect(retryStartsFirstAttempt({ status: "needs_attention" }, undefined, "needs_attention")).toBe(false);
    expect(retryStartsFirstAttempt({ status: "scheduled" }, undefined, "failed")).toBe(false);
    expect(retryStartsFirstAttempt({ status: "posted" }, undefined, "failed")).toBe(false);
  });
});

describe("the attempt Try again starts", () => {
  const now = new Date("2026-11-18T09:00:00Z");
  const budget = parseSocialPublicationAttemptBudget({
    SOCIAL_PUBLISH_PROVIDER_CALL_BUDGET: "10",
    SOCIAL_PUBLISH_MAX_ATTEMPTS: "3",
    SOCIAL_PUBLISH_PROCESSING_DEADLINE_MS: "3600000",
    SOCIAL_PUBLISH_RECONCILIATION_DEADLINE_MS: "7200000",
  });
  const base = { id: "next", postId: "post-1", frozenStateId: "frozen-1", actorUserId: "retrying-user", decisionId: "decision-1", now, budget };

  test("a post that never had an attempt gets attempt 1 owned by the person retrying", () => {
    const data = replacementAttemptData({ ...base, prior: undefined });
    expect(data).toMatchObject({
      id: "next",
      socialPostId: "post-1",
      frozenStateId: "frozen-1",
      attemptNumber: 1,
      priorAttemptId: null,
      executionActorUserId: "retrying-user",
      idempotencyKey: "publication:post-1:1",
      phase: "retry_scheduled",
      nextActionAt: now,
    });
  });

  test("a recovery attempt starts with the configured execution limits, not the schema defaults", () => {
    const data = replacementAttemptData({ ...base, prior: undefined });
    expect(data.providerCallCeiling).toBe(10);
    expect(data.nativeStartCeiling).toBe(13);
    expect(data.processingDeadline.getTime() - now.getTime()).toBe(3_600_000);
    expect(data.reconciliationDeadline.getTime() - now.getTime()).toBe(7_200_000);
  });

  test("a post with an attempt gets the next one, linked to it and keyed by the decision", () => {
    const data = replacementAttemptData({ ...base, prior: { id: "attempt-2", attemptNumber: 2, idempotencyKey: "publication:post-1:2" } });
    expect(data).toMatchObject({
      attemptNumber: 3,
      priorAttemptId: "attempt-2",
      executionActorUserId: "retrying-user",
      idempotencyKey: "publication:post-1:2:manual:decision-1",
    });
  });
});
