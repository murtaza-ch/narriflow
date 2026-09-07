import { describe, expect, test } from "bun:test";
import { parseSocialPublicationOperatorArgs } from "./social-publication-operator";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const POST_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

describe("Social Publication operator command", () => {
  test("defaults to identifier-safe read-only inspection", () => {
    expect(
      parseSocialPublicationOperatorArgs([
        "--workspace",
        WORKSPACE_ID,
        "--post",
        POST_ID,
      ]),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      socialPostId: POST_ID,
      recheck: false,
    });
  });

  test("requires actor and bounded reason for targeted reconciliation", () => {
    expect(
      parseSocialPublicationOperatorArgs([
        "--workspace",
        WORKSPACE_ID,
        "--post",
        POST_ID,
        "--recheck",
        "--actor",
        ACTOR_ID,
        "--reason",
        "Operator verified the provider account remains connected",
      ]),
    ).toMatchObject({ recheck: true, actorUserId: ACTOR_ID });
    expect(() =>
      parseSocialPublicationOperatorArgs([
        "--workspace",
        WORKSPACE_ID,
        "--post",
        POST_ID,
        "--recheck",
      ]),
    ).toThrow("--actor");
    expect(() =>
      parseSocialPublicationOperatorArgs([
        "--workspace",
        WORKSPACE_ID,
        "--post",
        POST_ID,
        "--delete",
      ]),
    ).toThrow("Unknown argument");
  });
});
