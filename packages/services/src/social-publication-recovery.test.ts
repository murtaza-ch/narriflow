import { describe, expect, test } from "bun:test";
import { allowedSocialPublicationActions } from "./social-publication-recovery";

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
});
