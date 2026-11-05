import { describe, expect, test } from "bun:test";
import {
  allowedSocialPublicationActions,
  socialPublicationReconnectRequired,
  validateSocialPublicationEvidence,
} from "./social-publication-recovery";

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
