import { describe, expect, test } from "bun:test";
import {
  deriveProjectPipelineStates,
  parseWorkflowEventMessage,
  rememberBoundedIdentity,
  workflowEventRowIdentity,
  workflowTerminalEventIdentity,
} from "./project-state";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_RUN_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_RUN_ID = "33333333-3333-4333-8333-333333333333";

function workflowEvent(workflowRunId: string, seq: number) {
  return {
    event: "workflow.stage.updated" as const,
    projectId: PROJECT_ID,
    workflowRunId,
    seq,
    stage: "clip_rendering" as const,
    status: "completed" as const,
    progress: 100,
    errorCode: null,
    emittedAt: `2026-07-10T00:00:0${seq}.000Z`,
  };
}

describe("workflow event state", () => {
  test("parses the shared event shape and safely rejects malformed messages", () => {
    const event = workflowEvent(FIRST_RUN_ID, 1);

    expect(parseWorkflowEventMessage(JSON.stringify(event))).toEqual(event);
    expect(parseWorkflowEventMessage("not-json")).toBeNull();
    expect(parseWorkflowEventMessage(JSON.stringify({ event: "wrong" }))).toBeNull();
  });

  test("refreshes two completed runs of the same stage once each", () => {
    const refreshed = new Set<string>();
    const first = workflowEvent(FIRST_RUN_ID, 1);
    const second = workflowEvent(SECOND_RUN_ID, 2);

    expect(
      rememberBoundedIdentity(refreshed, workflowTerminalEventIdentity(first)),
    ).toBe(true);
    expect(
      rememberBoundedIdentity(refreshed, workflowTerminalEventIdentity(first)),
    ).toBe(false);
    expect(
      rememberBoundedIdentity(refreshed, workflowTerminalEventIdentity(second)),
    ).toBe(true);
  });

  test("deduplicates rows and evicts the oldest bounded identity", () => {
    const rows = new Set<string>();
    const first = workflowEvent(FIRST_RUN_ID, 1);
    const second = workflowEvent(FIRST_RUN_ID, 2);
    const third = workflowEvent(FIRST_RUN_ID, 3);

    expect(rememberBoundedIdentity(rows, workflowEventRowIdentity(first), 2)).toBe(
      true,
    );
    expect(rememberBoundedIdentity(rows, workflowEventRowIdentity(first), 2)).toBe(
      false,
    );
    expect(rememberBoundedIdentity(rows, workflowEventRowIdentity(second), 2)).toBe(
      true,
    );
    expect(rememberBoundedIdentity(rows, workflowEventRowIdentity(third), 2)).toBe(
      true,
    );
    expect([...rows]).toEqual([
      workflowEventRowIdentity(second),
      workflowEventRowIdentity(third),
    ]);
  });
});

const EMPTY_PIPELINE = {
  clipCount: 0,
  latestRun: null,
  renderVariants: [],
  socialPosts: [],
} as const;

describe("project pipeline state", () => {
  test.each([
    ["success wins", { clipCount: 1, latestRun: { stage: "moment_detection", status: "failed" } }, "done"],
    ["active run", { latestRun: { stage: "moment_detection", status: "running" } }, "active"],
    ["failed run", { latestRun: { stage: "moment_detection", status: "failed" } }, "failed"],
    ["unrequested", {}, "todo"],
  ])("derives detection: %s", (_label, override, expected) => {
    expect(
      deriveProjectPipelineStates({ ...EMPTY_PIPELINE, ...override }).detect,
    ).toBe(expected);
  });

  test.each([
    [
      "success wins",
      [
        { status: "completed", hasAsset: true },
        { status: "rendering", hasAsset: false },
      ],
      "done",
    ],
    ["active variant", [{ status: "pending", hasAsset: false }], "active"],
    [
      "all requested variants failed",
      [
        { status: "failed", hasAsset: false },
        { status: "failed", hasAsset: false },
      ],
      "failed",
    ],
    ["unrequested", [], "todo"],
  ])("derives rendering: %s", (_label, renderVariants, expected) => {
    expect(
      deriveProjectPipelineStates({ ...EMPTY_PIPELINE, renderVariants }).render,
    ).toBe(expected);
  });

  test.each([
    ["success wins", [{ status: "failed" }, { status: "posted" }], "done"],
    ["active post", [{ status: "scheduled" }], "active"],
    ["failed post", [{ status: "failed" }], "failed"],
    ["unrequested", [], "todo"],
  ])("derives publishing: %s", (_label, socialPosts, expected) => {
    expect(
      deriveProjectPipelineStates({ ...EMPTY_PIPELINE, socialPosts }).publish,
    ).toBe(expected);
  });
});
