import { describe, expect, test } from "bun:test";
import { deriveProjectListProgress, deriveProjectPipeline, deriveProcessingChecklist, resolveProjectProgressRun } from "./project-progress";

describe("Project list progress", () => {
	test("keeps a project processing through detection after transcription completes", () => {
		expect(
			deriveProjectListProgress({
				ingestStatus: "ready",
				workflowRuns: [
					{
						id: "run-1",
						stage: "stt",
						status: "completed",
						updatedAt: "2026-09-13T10:00:00.000Z",
					},
					{
						id: "run-2",
						stage: "moment_detection",
						status: "running",
						updatedAt: "2026-09-13T10:01:00.000Z",
					},
				],
			}),
		).toEqual({ status: "processing", label: "Detecting", active: true });
	});

	test("keeps queued workflow work visible and makes terminal outcomes useful", () => {
		expect(
			deriveProjectListProgress({
				ingestStatus: "ready",
				workflowRuns: [
					{
						id: "run-3",
						stage: "clip_rendering",
						status: "queued",
						updatedAt: "2026-09-13T10:01:00.000Z",
					},
				],
			}),
		).toEqual({ status: "queued", label: "Render queued", active: true });
		expect(
			deriveProjectListProgress({
				ingestStatus: "ready",
				workflowRuns: [
					{
						id: "run-4",
						stage: "clip_rendering",
						status: "partial",
						updatedAt: "2026-09-13T10:01:00.000Z",
					},
				],
			}),
		).toEqual({ status: "ready", label: "Partially ready", active: false });
	});

	test("does not let a superseded workflow failure hide a newer completed stage", () => {
		expect(
			deriveProjectListProgress({
				ingestStatus: "ready",
				workflowRuns: [
					{
						id: "run-5",
						stage: "moment_detection",
						status: "failed",
						updatedAt: "2026-09-13T10:00:00.000Z",
					},
					{
						id: "run-6",
						stage: "moment_detection",
						status: "completed",
						updatedAt: "2026-09-13T10:01:00.000Z",
					},
				],
			}),
		).toEqual({ status: "ready", label: "Ready", active: false });
	});
});

const EMPTY_PIPELINE = {
  ingestStatus: "ready",
  transcript: null,
  clipCount: 0,
  latestRun: null,
  renderVariants: [],
  socialPosts: [],
} as const;

describe("project pipeline state", () => {
  test.each([
    ["current failure remains visible", { clipCount: 1, latestRun: { progress: 0, errorCode: null, stage: "moment_detection", status: "failed" } }, "failed"],
    ["active run", { latestRun: { progress: 0, errorCode: null, stage: "moment_detection", status: "running" } }, "active"],
    ["waiting run", { latestRun: { progress: 0, errorCode: null, stage: "moment_detection", status: "waiting" } }, "active"],
    ["failed run", { latestRun: { progress: 0, errorCode: null, stage: "moment_detection", status: "failed" } }, "failed"],
    ["unrequested", {}, "todo"],
  ])("derives detection: %s", (_label, override, expected) => {
    expect(
      deriveProjectPipeline({ ...EMPTY_PIPELINE, ...override }).detect,
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
      deriveProjectPipeline({ ...EMPTY_PIPELINE, renderVariants }).render,
    ).toBe(expected);
  });

  test("an active render run stays active after its first asset completes", () => {
    expect(
      deriveProjectPipeline({
        ...EMPTY_PIPELINE,
        latestRun: { progress: 0, errorCode: null, stage: "clip_rendering", status: "running" },
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
    ["preparing post", [{ status: "preparing_video" }], "active"],
    ["provider processing", [{ status: "processing" }], "active"],
    ["reconciling outcome", [{ status: "reconciling" }], "active"],
    ["failed post", [{ status: "failed" }], "failed"],
    ["attention required", [{ status: "needs_attention" }], "failed"],
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
      deriveProjectPipeline({ ...EMPTY_PIPELINE, socialPosts }).publish,
    ).toBe(expected);
  });
});


describe("processing checklist workflow-v2 states", () => {
  const base = {
    ingestStatus: "ready",
    transcribe: { status: "completed" as const, progress: 100, errorCode: null },
    detect: { status: "completed" as const, progress: 100, errorCode: null },
    render: { status: "queued" as const, progress: 0, errorCode: null },
    mode: "clip" as const,
  };

  test("detected clips wait for rendering even after the first artifact lands", () => {
    const nodes = deriveProcessingChecklist(base);
    expect(nodes.find((node) => node.id === "render")?.state).not.toBe("done");
    expect(nodes.find((node) => node.id === "done")?.state).not.toBe("done");
  });

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
    });
    expect(nodes.find((node) => node.id === "render")?.state).toBe("done");
    expect(nodes.find((node) => node.id === "done")?.state).toBe("done");
  });
});

describe("canonical Project progress", () => {
  test("active status, updated time and descending identity choose the same run in any input order", () => {
    const runs = [
      { id: "00000000-0000-4000-8000-000000000004", stage: "clip_rendering", status: "completed", updatedAt: "2026-10-04T12:00:00Z" },
      { id: "00000000-0000-4000-8000-000000000001", stage: "stt", status: "running", updatedAt: "2026-10-04T10:00:00Z" },
      { id: "00000000-0000-4000-8000-000000000002", stage: "moment_detection", status: "waiting", updatedAt: "2026-10-04T11:00:00Z" },
      { id: "00000000-0000-4000-8000-000000000003", stage: "clip_rendering", status: "queued", updatedAt: "2026-10-04T11:00:00Z" },
    ];
    for (const order of [runs, [...runs].reverse(), [runs[2]!, runs[0]!, runs[3]!, runs[1]!]]) {
      expect(resolveProjectProgressRun(order)?.id).toBe(runs[3]!.id);
      expect(deriveProjectListProgress({ ingestStatus: "ready", workflowRuns: order })).toEqual({ status: "queued", label: "Render queued", active: true });
    }
    const terminal = [
      { ...runs[2]!, status: "failed" },
      { ...runs[3]!, status: "partial" },
    ];
    expect(resolveProjectProgressRun(terminal)?.id).toBe(runs[3]!.id);
    expect(resolveProjectProgressRun([...terminal].reverse())?.id).toBe(runs[3]!.id);
  });

  test.each(["stt", "moment_detection", "clip_rendering"])("a current %s failure overrides artifacts in both detail views", (stage) => {
    const pipeline = deriveProjectPipeline({
      ...EMPTY_PIPELINE,
      transcript: { status: "completed" },
      clipCount: 3,
      latestRun: { stage, status: "failed", progress: 20, errorCode: "test_failure" },
      renderVariants: [{ status: "completed", hasAsset: true }],
    });
    const nodeId = stage === "stt" ? "transcribe" : stage === "moment_detection" ? "detect" : "render";
    expect(pipeline[nodeId]).toBe("failed");
    const checklist = deriveProcessingChecklist({ ...pipeline.processingStages, ingestStatus: "ready", mode: "clip" });
    expect(checklist.find(node => node.id === nodeId)).toMatchObject({ state: "failed", errorCode: "test_failure" });
    expect(checklist.find(node => node.id === "done")?.state).toBe("todo");
  });
});


describe("processing recovery visibility", () => {
  test.each(["queued", "running", "waiting", "failed"])("old renders do not conceal a current detection %s outcome", (status) => {
    const pipeline = deriveProjectPipeline({ ...EMPTY_PIPELINE, transcript: { status: "completed" }, clipCount: 3,
      latestRun: { stage: "moment_detection", status, progress: 25, errorCode: status === "failed" ? "workflow_content_pack_invalid" : null },
      renderVariants: [{ status: "completed", hasAsset: true }],
    });
    expect(pipeline.render).toBe("done");
    expect(pipeline.hasUnfinishedProcessing).toBe(true);
  });
  test("an unrelated dubbing run does not reopen clipping recovery", () => {
    const pipeline = deriveProjectPipeline({ ...EMPTY_PIPELINE, transcript: { status: "completed" }, clipCount: 3,
      latestRun: { stage: "dubbing", status: "running", progress: 25, errorCode: null },
      renderVariants: [{ status: "completed", hasAsset: true }],
    });
    expect(pipeline.hasUnfinishedProcessing).toBe(false);
  });
});
