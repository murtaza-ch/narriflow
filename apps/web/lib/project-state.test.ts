import { describe, expect, test } from "bun:test";
import {
  ingestRecoveryAction,
  liveIngestStageWord,
  mergePipelineStepsWithLiveEvents,
  mergeStageWithLiveEvent,
  parseWorkflowEventMessage,
  pipelineStepStateWord,
  projectActivityRows,
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
  test("ingest identities preserve distinct jobs and reject mixed execution identities", () => {
    const first = { ...workflowEvent(FIRST_RUN_ID, 1), workflowRunId: null, ingestJobId: FIRST_RUN_ID, stage: "ingest" as const };
    const second = { ...first, ingestJobId: SECOND_RUN_ID, seq: 2 };
    expect(parseWorkflowEventMessage(JSON.stringify(first))).toEqual(first);
    expect(parseWorkflowEventMessage(JSON.stringify({ ...first, workflowRunId: FIRST_RUN_ID }))).toBeNull();
    expect(workflowTerminalEventIdentity(first)).toBe(`${FIRST_RUN_ID}:1`);
    expect(projectActivityRows([first, second]).map((event) => event.ingestJobId)).toEqual([SECOND_RUN_ID, FIRST_RUN_ID]);
  });

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

  test("collapses duplicate render milestones but preserves distinct runs", () => {
    const progress = {
      ...workflowEvent(FIRST_RUN_ID, 1),
      status: "running" as const,
      progress: 18,
    };
    const childCompleted = { ...progress, seq: 2 };
    const nextMilestone = { ...progress, seq: 3, progress: 26 };
    const anotherRun = {
      ...progress,
      workflowRunId: SECOND_RUN_ID,
      seq: 4,
    };

    expect(
      projectActivityRows([
        progress,
        childCompleted,
        nextMilestone,
        anotherRun,
      ]).map((event) => event.seq),
    ).toEqual([4, 3, 2]);
  });
});

describe("pipeline status copy", () => {
  test("advances adjacent header stages from the same live workflow run", () => {
    const sttCompleted = {
      ...workflowEvent(FIRST_RUN_ID, 8),
      stage: "stt" as const,
    };
    const detectionRunning = {
      ...workflowEvent(FIRST_RUN_ID, 9),
      stage: "moment_detection" as const,
      status: "running" as const,
      progress: 20,
    };
    const oldRenderCompleted = workflowEvent(SECOND_RUN_ID, 10);

    expect(
      mergePipelineStepsWithLiveEvents(
        [
          { label: "Ingest", state: "done" },
          { label: "Transcribe", state: "active", status: "waiting" },
          { label: "Detect", state: "todo" },
          { label: "Render", state: "active", status: "running" },
        ],
        {
          stt: sttCompleted,
          moment_detection: detectionRunning,
          clip_rendering: oldRenderCompleted,
        },
        FIRST_RUN_ID,
      ),
    ).toEqual([
      { label: "Ingest", state: "done" },
      { label: "Transcribe", state: "done", status: "completed" },
      { label: "Detect", state: "active", status: "running" },
      { label: "Render", state: "active", status: "running" },
    ]);
  });

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



test("processing checklist ignores another run's history just as the header does", () => {
  const server = { status: "failed" as const, progress: 20, errorCode: "render_failed" };
  const oldCompletion = workflowEvent(SECOND_RUN_ID, 10);
  expect(mergeStageWithLiveEvent(server, oldCompletion, FIRST_RUN_ID)).toEqual(server);
  expect(mergeStageWithLiveEvent(server, oldCompletion, null)).toEqual(server);
  expect(mergeStageWithLiveEvent(server, workflowEvent(FIRST_RUN_ID, 11), FIRST_RUN_ID)).toEqual({ status: "completed", progress: 100, errorCode: null });
});
