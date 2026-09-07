import { describe, expect, test } from "bun:test";
import {
  allowedSocialPublicationActions,
  validateSocialPublicationEvidence,
} from "./social-publication-recovery";

describe("Social Publication recovery actions", () => {
  test("offers only safe actions for each terminal projection", () => {
    expect(
      allowedSocialPublicationActions({
        status: "needs_attention",
        errorCode: "publication_outcome_unknown",
        workspace: { status: "active" },
        socialAccount: { status: "active" },
      }),
    ).toEqual(["recheck", "confirm_published", "publish_again"]);
    expect(
      allowedSocialPublicationActions({
        status: "failed",
        errorCode: "x_post_failed",
      }),
    ).toEqual(["schedule_again"]);
  });

  test("workspace restriction and account revocation stop new provider work", () => {
    expect(
      allowedSocialPublicationActions({
        status: "needs_attention",
        errorCode: "publication_outcome_unknown",
        workspace: { status: "restricted" },
        socialAccount: { status: "active" },
      }),
    ).toEqual(["recheck", "confirm_published"]);
    expect(
      allowedSocialPublicationActions({
        status: "needs_attention",
        errorCode: "publication_outcome_unknown",
        workspace: { status: "active" },
        socialAccount: { status: "revoked" },
      }),
    ).toEqual(["confirm_published", "reconnect_account"]);
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
