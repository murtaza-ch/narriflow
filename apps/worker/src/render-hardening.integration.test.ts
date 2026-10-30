import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createOrdinaryTracer } from "./tasks/clip-render-attempt.fixture.test";
import { renderTelemetryReport } from "../scripts/render-telemetry-report";

// Runs the complete attempt with its planner/compiler/validator and bounded
// delivery adapters. Native media and durable lease recovery are separate gates.
for (const fault of [undefined, "upload", "command_nonzero_exit", "cleanup"] as const) {
  test(`integrated telemetry preserves ${fault ?? "successful"} settlement`, async () => {
    const h = createOrdinaryTracer({ attemptId: randomUUID(), failure: fault,
      outcome: { status: fault === "upload" || fault === "command_nonzero_exit" ? "queued" : "completed", requested: 1, succeeded: fault === "upload" || fault === "command_nonzero_exit" ? 0 : 1, failed: 0, superseded: 0 } });
    await h.clipRenderAttempt.execute(h.attempt, { signal: new AbortController().signal, reportProgress: async () => {} });
    const metrics = h.diagnostics.filter((d) => d.message === "clip_render_attempt_metrics");
    expect(metrics).toHaveLength(1);
    const phases = metrics[0]!.context!.phaseOperations as Record<string, number>;
    expect(phases.compose).toBeGreaterThan(0);
    expect(phases.encode).toBeGreaterThan(0);
    const logs = h.diagnostics.map((d) => JSON.stringify({ ...d.context, message: d.message })).join("\n");
    const report = renderTelemetryReport(logs, h.attempt.workflowRunId);
    expect(report.loggedExecutionSummaries).toBe(1);
    expect(report.missingValidation).toEqual([]);
    expect(report.valid).toBe(true);
    if (fault === "upload" || fault === "command_nonzero_exit") expect(report.counts.retryable).toBe(1);
    if (!fault || fault === "cleanup") expect(h.variantState()).toBe("completed");
  });
}

test("operator telemetry check rejects incomplete logs and unvalidated accepted artifacts", () => {
  expect(renderTelemetryReport("", "run").valid).toBe(false);
  const logs = [{ workflowRunId: "run", workflowAttemptId: "token", message: "clip_render_attempt_metrics", phaseMs: {}, elapsedMs: 1 },
    { workflowRunId: "run", workflowAttemptId: "token", message: "clip_render_variant_completed", clipRenderId: "variant" }].map((e) => JSON.stringify(e)).join("\n");
  expect(renderTelemetryReport(logs, "run")).toMatchObject({ valid: false, missingValidation: ["variant"] });
});

import { createCoreRenderPathTracer } from "./tasks/clip-render-attempt-core-paths.fixture.test";

test("paired frozen evidence workload skips detectors with identical encode arguments", async () => {
  const samples: Record<string, number[]> = { fresh: [], reused: [] };
  const rssSamples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const fresh = createCoreRenderPathTracer({ topology: "single-video", clipOverrides: { previewStorageKey: "projects/test/previews/paired.mp4", editorRevision: 0, studioEdits: { framing: { mode: "screen" } } },
      faceAnalysisSamples: [{ t: 0, cx: .5 }, { t: 5, cx: .5 }, { t: 10, cx: .5 }],
      pipAnalysisResult: { movingPxFrac: .04, insufficientSamples: false, candidates: [] } });
    let start = performance.now();
    await fresh.clipRenderAttempt.execute(fresh.attempt, { signal: new AbortController().signal, reportProgress: async () => {} });
    samples.fresh!.push(performance.now() - start);
    expect(fresh.persistedScreenLayouts).toHaveLength(1);
    const reused = createCoreRenderPathTracer({ topology: "single-video", clipOverrides: { previewStorageKey: "projects/test/previews/paired.mp4", editorRevision: 0, studioEdits: { framing: { mode: "screen" } }, layoutAnalysis: fresh.persistedScreenLayouts[0] }, faceAnalysisFailure: new Error("reuse must skip analysis") });
    start = performance.now();
    await reused.clipRenderAttempt.execute(reused.attempt, { signal: new AbortController().signal, reportProgress: async () => {} });
    samples.reused!.push(performance.now() - start);
    const resourceSample = reused.diagnostics.find((e) => e.message === "clip_render_attempt_metrics")?.context;
    rssSamples.push(Number(resourceSample?.workerRssBytes ?? 0));
    expect(reused.analysisCounts()).toEqual({ extraction: 0, face: 0, multiFace: 0, pip: 0, scene: 0 });
    expect(reused.commands.map((c) => c.args)).toEqual(fresh.commands.map((c) => c.args));
    console.warn(JSON.stringify({ level: "info", message: "render_reuse_sample", sample: i, fresh: fresh.analysisCounts(), reused: reused.analysisCounts(), freshMs: samples.fresh!.at(-1), reusedMs: samples.reused!.at(-1), workload: "frozen document; real planner/compiler; injected detectors, encoder, storage" }));
  }
  for (const [mode, times] of Object.entries(samples)) {
    const sorted = [...times].sort((a,b) => a-b);
    console.warn(JSON.stringify({level: "info", message: "render_reuse_summary", mode, samples: times.length, p50Ms: sorted[2], p95Ms: sorted[4], nativeDetectorTimeMeasured: false, sampledWorkerRssPeakBytes: Math.max(...rssSamples), resourceScope: "test runner RSS sampled at attempt end; excludes native detector/encoder/storage work"}));
  }
});
