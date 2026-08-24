import { describe, expect, test } from "bun:test";
import {
  deriveProcessingChecklist,
  deriveProjectPipelineStates,
  ingestRecoveryAction,
  liveIngestStageWord,
  parseWorkflowEventMessage,
  pipelineStepStateWord,
  rememberBoundedIdentity,
  workflowEventRowIdentity,
  workflowTerminalEventIdentity,
} from "./project-state";

describe("ingest recovery action", () => {
  test("provider access rejection directs the user to a new upload", () => {
    expect(ingestRecoveryAction("source_provider_access_denied")).toBe(
      "new_upload",
    );
  });

  test("a transient exhausted import remains manually retryable", () => {
    expect(ingestRecoveryAction("ingest_retries_exhausted")).toBe("retry");
  });
});

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
    ["waiting run", { latestRun: { stage: "moment_detection", status: "waiting" } }, "active"],
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

  test("an active render run stays active after its first asset completes", () => {
    expect(
      deriveProjectPipelineStates({
        ...EMPTY_PIPELINE,
        latestRun: { stage: "clip_rendering", status: "running" },
        renderVariants: [
          { status: "completed", hasAsset: true },
          { status: "rendering", hasAsset: false },
        ],
      }).render,
    ).toBe("active");
  });

  test.each([
    ["success wins", [{ status: "failed" }, { status: "posted" }], "done"],
    ["active post", [{ status: "scheduled" }], "active"],
    ["failed post", [{ status: "failed" }], "failed"],
    ["unrequested", [], "todo"],
    // Posts orphaned by clip deletion (clipId SetNull — e.g. after
    // "Regenerate clips") are history, not current pipeline state: a fresh
    // clip set with zero renders must not show Publish as done.
    [
      "orphaned posted post ignored",
      [{ status: "posted", clipId: null }],
      "todo",
    ],
    [
      "orphaned failed post ignored",
      [{ status: "failed", clipId: null }, { status: "scheduled", clipId: "c1" }],
      "active",
    ],
  ])("derives publishing: %s", (_label, socialPosts, expected) => {
    expect(
      deriveProjectPipelineStates({ ...EMPTY_PIPELINE, socialPosts }).publish,
    ).toBe(expected);
  });
});

describe("pipeline status copy", () => {
  test("preserves queued, waiting, and running instead of calling all active work running", () => {
    expect(pipelineStepStateWord("active", "queued")).toBe("queued");
    expect(pipelineStepStateWord("active", "waiting")).toBe("waiting");
    expect(pipelineStepStateWord("active", "running")).toBe("running");
  });

  test("shows an automatic ingest retry as retrying", () => {
    const retrying = {
      ...workflowEvent(FIRST_RUN_ID, 2),
      stage: "ingest_retrying" as const,
      status: "queued" as const,
      progress: 40,
    };
    expect(liveIngestStageWord({ ingest_retrying: retrying }, "queued")).toBe(
      "Retrying",
    );
  });
});

describe("processing checklist workflow-v2 states", () => {
  const base = {
    ingestStatus: "ready",
    transcribe: { status: "completed" as const, progress: 100, errorCode: null },
    detect: { status: "completed" as const, progress: 100, errorCode: null },
    render: { status: "queued" as const, progress: 0, errorCode: null },
    mode: "clip" as const,
    autoRenderClips: true,
    clipCount: 2,
    hasAnyRendered: false,
  };

  test("waiting remains active", () => {
    const nodes = deriveProcessingChecklist({
      ...base,
      render: { status: "waiting", progress: 40, errorCode: null },
    });
    expect(nodes.find((node) => node.id === "render")?.state).toBe("active");
  });

  test("partial is terminal and keeps successful artifacts usable", () => {
    const nodes = deriveProcessingChecklist({
      ...base,
      render: {
        status: "partial",
        progress: 100,
        errorCode: "partial_render_failure",
      },
      hasAnyRendered: true,
    });
    expect(nodes.find((node) => node.id === "render")?.state).toBe("done");
    expect(nodes.find((node) => node.id === "done")?.state).toBe("done");
  });
});
