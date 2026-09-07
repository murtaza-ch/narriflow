import { describe, expect, test } from "bun:test";
import { parseGeneratedMediaOperatorArgs } from "./generated-media-operator";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

describe("Generated Media operator command", () => {
  test("defaults to scoped read-only inspection", () => {
    expect(parseGeneratedMediaOperatorArgs(["--workspace", WORKSPACE_ID, "--job", JOB_ID])).toEqual({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      reconcile: false,
    });
  });

  test("requires an actor, reason, and provider reference for completed reconciliation", () => {
    expect(parseGeneratedMediaOperatorArgs([
      "--workspace", WORKSPACE_ID,
      "--job", JOB_ID,
      "--decision", "completed",
      "--actor", ACTOR_ID,
      "--reason", "provider_dashboard_verified",
      "--provider-ref", "openai:image:confirmed",
    ])).toMatchObject({
      reconcile: true,
      actorUserId: ACTOR_ID,
      decision: { kind: "completed", providerRef: "openai:image:confirmed", usageImages: 1 },
    });
    expect(() => parseGeneratedMediaOperatorArgs([
      "--workspace", WORKSPACE_ID,
      "--job", JOB_ID,
      "--decision", "completed",
    ])).toThrow("--actor");
  });

  test("requires an explicit bounded code for terminal reconciliation", () => {
    expect(() => parseGeneratedMediaOperatorArgs([
      "--workspace", WORKSPACE_ID,
      "--job", JOB_ID,
      "--decision", "failed",
      "--actor", ACTOR_ID,
      "--reason", "provider_dashboard_verified",
    ])).toThrow("--code");
  });

  test("rejects free-form operator reason and terminal text", () => {
    expect(() => parseGeneratedMediaOperatorArgs([
      "--workspace", WORKSPACE_ID, "--job", JOB_ID, "--decision", "failed",
      "--actor", ACTOR_ID, "--reason", "the prompt contained private content", "--code", "provider said no",
    ])).toThrow("--reason must be one of");
  });
});
