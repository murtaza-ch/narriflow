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
