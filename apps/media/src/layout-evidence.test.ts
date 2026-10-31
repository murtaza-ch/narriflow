import { describe, expect, test } from "bun:test";
import { compositionAssetRef, planClipComposition, splitLayoutInputFingerprint, type CompositionEvidenceRequest } from "@narriflow/composition-plan";
import { CLIP_AUTO_LAYOUT_ENGINE, SCREEN_LAYOUT_ENGINE_VERSION, editorDocumentSchema, captionPresetSchema } from "@narriflow/validators";
import { LayoutEvidence, type LayoutEvidenceDependencies, type LayoutEvidenceInput, type LayoutEvidenceWrite } from "./layout-evidence";
import { parseRenderConfig } from "./render-config";
import { analyzeClipAutoLayout } from "./tasks/auto-layout-analysis";
import { WorkflowFailure } from "@narriflow/services";
import { deriveRenderCompositionEvidence } from "./tasks/clip-render-attempt";
import { WorkerProcessFailure, type WorkerProcessModule } from "./worker-process";

const requests: CompositionEvidenceRequest[] = [
  { key: "automatic", kind: "automatic-speaker-layout", engineVersion: CLIP_AUTO_LAYOUT_ENGINE },
  { key: "screen", kind: "screen-layout", engineVersion: SCREEN_LAYOUT_ENGINE_VERSION },
  { key: "split", kind: "split-speaker-layout", engineVersion: "explicit-split-v1" },
];
const face = (cx: number) => ({ cx, cy: 0.35, w: 0.1, h: 0.2, score: 0.95 });
const samples = Array.from({ length: 40 }, (_, i) => ({ t: i * 0.25, faces: [face(0.3), face(0.7)] }));
function input(overrides: Partial<LayoutEvidenceInput> = {}): LayoutEvidenceInput {
  return {
    source: { identity: compositionAssetRef("source", "project-1"), width: 1920, height: 1080, hasVideo: true },
    clip: { id: "clip-1", startSec: 10, endSec: 20, deletedRanges: [], utterances: [], editorRevision: 7, previewStorageKey: "preview" },
    durable: {}, enabled: { automatic: true, screen: true, split: true }, hasBroll: false, pipMotionThreshold: 0.12,
    signal: new AbortController().signal,
    sceneSource: { path: "original-1920x1080.mp4", startSec: 10 },
    getSegment: async () => ({ path: "original-or-proxy.mp4", startSec: 0, durationSec: 10 }),
    ...overrides,
  };
}
function harness(value = input(), overrides: Partial<LayoutEvidenceDependencies> = {}) {
  const writes: LayoutEvidenceWrite[] = [];
  const calls = { segment: 0, multi: 0, face: 0, pip: 0, cuts: 0 };
  const dependencies: LayoutEvidenceDependencies = {
    detectors: {
      detectMultiFacePath: async () => { calls.multi += 1; return { samples }; },
      detectFacePath: async () => { calls.face += 1; return { samples: [{ t: 0, cx: 0.3 }, { t: 9, cx: 0.7 }] }; },
      detectPipPath: async () => { calls.pip += 1; return { movingPxFrac: 0.8, insufficientSamples: false, candidates: [] }; },
      detectSceneCuts: async () => { calls.cuts += 1; return [5]; },
    },
    persist: async (write, snapshot) => { expect(snapshot.editorRevision).toBe(7); writes.push(write); return true; },
    now: () => 1_700_000_000_000,
    rethrowControl: () => {}, diagnose: () => {}, delay: async () => {}, ...overrides,
  };
  const owner = new LayoutEvidence({ ...value, getSegment: async () => { calls.segment += 1; return value.getSegment(); } }, dependencies);
  return { owner, writes, calls, dependencies };
}

describe("LayoutEvidence", () => {
  test("frames faces to a consistent size across landscape, square and portrait originals", async () => {
    for (const [width, height] of [[640, 338], [1920, 1080], [1080, 1080], [1080, 1920]]) {
      const h = harness(input({ source: { identity: "source:zoom", width: width!, height: height!, hasVideo: true } }));
      await h.owner.fulfill(requests.slice(0, 1));
      const result = h.owner.availability.automaticLayout;
      if (result.state !== "available") throw new Error("expected Automatic evidence");
      expect(result.value.analysis.sourceWidth).toBe(width);
      expect(result.value.analysis.sourceHeight).toBe(height);
      for (const segment of result.value.analysis.segments) {
        expect(segment.layout).toBe("two-up");
        if (segment.layout !== "two-up") throw new Error("expected two camera seats");
        expect(0.2 * segment.topZoom).toBeCloseTo(0.26, 5);
        expect(0.2 * segment.bottomZoom).toBeCloseTo(0.26, 5);
        expect(segment.topCropTrack?.[0]?.cyNorm).toBe(segment.topCyNorm);
        expect(segment.bottomCropTrack?.[0]?.cyNorm).toBe(segment.bottomCyNorm);
      }
    }
  });

  test("frames small podcast faces without leaving the table and chairs dominant", async () => {
    const h = harness();
    h.dependencies.detectors.detectMultiFacePath = async () => ({
      samples: samples.map((sample) => ({
        t: sample.t,
        faces: [
          { ...face(0.17), cy: 0.23, h: 0.11 },
          { ...face(0.81), cy: 0.22, h: 0.12 },
        ],
      })),
    });
    await h.owner.fulfill(requests.slice(0, 1));
    const result = h.owner.availability.automaticLayout;
    if (result.state !== "available") throw new Error("expected Automatic evidence");
    for (const segment of result.value.analysis.segments) {
      if (segment.layout !== "two-up") throw new Error("expected two camera seats");
      expect(0.11 * segment.topZoom).toBeCloseTo(0.26, 5);
      expect(0.12 * segment.bottomZoom).toBeCloseTo(0.26, 5);
      expect(segment.topZoom).toBeLessThanOrEqual(2.5);
      expect(segment.bottomZoom).toBeLessThanOrEqual(2.5);
      expect((segment.topCyNorm - 0.23) * segment.topZoom).toBeCloseTo(0.08, 5);
      expect((segment.bottomCyNorm - 0.22) * segment.bottomZoom).toBeCloseTo(0.08, 5);
    }
  });

  test("fulfills all requested engines with one lazy segment and one shared multi-face pass", async () => {
    const h = harness();
    const result = await h.owner.fulfill([...requests, ...requests]);
    expect(result.automaticLayout.state).toBe("available");
    expect(result.screenLayout.state).toBe("available");
    expect(result.splitLayout.state).toBe("available");
    expect(h.calls).toEqual({ segment: 1, multi: 1, face: 1, pip: 1, cuts: 1 });
    expect(h.writes.map((write) => write.kind)).toEqual(["automatic", "screen", "split"]);
    expect(h.owner.resources).toMatchObject({ analysisExecutionCount: 3, detectorExecutionCount: 4 });
  });

  test("reuses complete durable evidence before the planner requests any media", async () => {
    const fresh = harness();
    await fresh.owner.fulfill(requests);
    const durable = Object.fromEntries(fresh.writes.map((write) => [write.kind, write.value]));
    const reused = harness(input({ durable }));
    expect(reused.owner.availability.automaticLayout.state).toBe("available");
    await reused.owner.fulfill(requests);
    expect(reused.calls).toEqual({ segment: 0, multi: 0, face: 0, pip: 0, cuts: 0 });
    expect(reused.writes).toEqual([]);
    expect(reused.owner.automaticSource).toBe("durable");
    expect(reused.owner.resources.analysisExecutionCount).toBe(0);
  });

  test.each(["trim", "dimensions", "deleted ranges"])("rejects durable evidence after changing %s", async (change) => {
    const fresh = harness(); await fresh.owner.fulfill(requests);
    const durable = Object.fromEntries(fresh.writes.map((write) => [write.kind, write.value]));
    const base = input({ durable });
    if (change === "trim") base.clip = { ...base.clip, startSec: 11 };
    if (change === "dimensions") base.source = { ...base.source, width: 3840, height: 2160 };
    if (change === "deleted ranges") base.clip = { ...base.clip, deletedRanges: [{ startSec: 13, endSec: 15 }] };
    const h = harness(base); await h.owner.fulfill(requests);
    expect(h.calls.segment).toBe(1);
    expect(h.writes.some((write) => write.kind === "automatic")).toBe(true);
    const analysis = h.owner.availability.automaticLayout;
    expect(analysis.state).toBe("available");
    if (analysis.state === "available") expect(analysis.value.analysis.editedDurationSec).toBe(change === "trim" ? 9 : change === "deleted ranges" ? 8 : 10);
  });

  test("disabled engines and B-roll conflicts never request the lazy segment", async () => {
    const disabled = harness(input({ enabled: { automatic: false, screen: false, split: false } }));
    expect(await disabled.owner.fulfill(requests)).toMatchObject({ automaticLayout: { state: "disabled" }, screenLayout: { state: "disabled" }, splitLayout: { state: "disabled" } });
    expect(disabled.calls.segment).toBe(0);
    const broll = harness(input({ hasBroll: true }));
    expect(await broll.owner.fulfill(requests.slice(1))).toMatchObject({ screenLayout: { state: "failed", reason: "broll_conflict" }, splitLayout: { state: "failed", reason: "broll_conflict" } });
    expect(broll.calls.segment).toBe(0);
    expect(broll.owner.resources.analysisExecutionCount).toBe(0);
  });

  test("partial proxy coverage cannot publish an Automatic full-window envelope", async () => {
    const h = harness(input({ getSegment: async () => ({ path: "truncated.mp4", startSec: 0, durationSec: 6 }) }));
    expect(await h.owner.fulfill(requests)).toMatchObject({ automaticLayout: { state: "failed" }, screenLayout: { state: "failed" }, splitLayout: { state: "failed" } });
    expect(h.calls).toEqual({ segment: 3, multi: 0, face: 0, pip: 0, cuts: 0 });
    expect(h.writes).toEqual([]);
  });

  test("retries a failed segment and keeps infrastructure failure separate from conclusive no-face evidence", async () => {
    const unavailable = harness(input({ getSegment: async () => { throw new Error("range unavailable"); } }));
    await unavailable.owner.fulfill(requests);
    expect(unavailable.calls.segment).toBe(3);
    expect(unavailable.owner.availability.automaticLayout).toEqual({ state: "failed" });
    const empty = harness();
    empty.dependencies.detectors.detectMultiFacePath = async () => ({ samples: [] });
    await empty.owner.fulfill(requests.slice(0, 1));
    const available = empty.owner.availability.automaticLayout;
    expect(available.state).toBe("available");
    if (available.state === "available") expect(available.value.analysis.segments).toEqual([]);
    expect(empty.writes).toHaveLength(1);
  });

  test("remaps cut coverage onto edited time without analyzing a second segment", async () => {
    const base = input(); base.clip.deletedRanges = [{ startSec: 13, endSec: 15 }];
    const h = harness(base); await h.owner.fulfill(requests);
    expect(h.calls.segment).toBe(1);
    const result = h.owner.availability.automaticLayout;
    expect(result.state).toBe("available");
    if (result.state === "available") {
      expect(result.value.analysis.editedDurationSec).toBe(8);
      expect(result.value.analysis.segments.at(-1)?.endSec).toBe(8);
      expect(result.value.analysis.segments.every((segment) => segment.endSec <= 8)).toBe(true);
    }
  });

  test("cancellation after a detector that ignores abort prevents all durable writes", async () => {
    const controller = new AbortController(); const reason = { kind: "shutdown" };
    const h = harness(input({ signal: controller.signal }));
    h.dependencies.detectors.detectMultiFacePath = async () => { controller.abort(reason); return { samples }; };
    await expect(h.owner.fulfill(requests)).rejects.toBe(reason);
    expect(h.writes).toEqual([]);
  });

  test("ownership loss from a fenced write propagates rather than degrading", async () => {
    const lost = new Error("ownership lost");
    const h = harness(input(), { persist: async () => { throw lost; }, rethrowControl: (error) => { if (error === lost) throw error; } });
    await expect(h.owner.fulfill(requests)).rejects.toBe(lost);
    expect(h.owner.resources.persistenceFailures).toBe(0);
    expect(h.owner.availability.automaticLayout.state).toBe("missing");
  });

  test("a rejected revision write leaves only frozen render evidence usable", async () => {
    const h = harness(input(), { persist: async () => false });
    await h.owner.fulfill(requests.slice(0, 1));
    expect(h.owner.availability.automaticLayout.state).toBe("available");
    expect(h.owner.resources.persistenceSkipped).toBe(1);
  });

  test("transient persistence failure preserves current rendering and reports failure", async () => {
    const h = harness(input(), { persist: async () => { throw new Error("database unavailable"); } });
    await h.owner.fulfill(requests);
    expect(h.owner.resources.persistenceFailures).toBe(3);
    expect(h.owner.availability).toMatchObject({ automaticLayout: { state: "available" }, screenLayout: { state: "available" }, splitLayout: { state: "available" } });
  });

  test("audio-only Automatic evidence needs no media segment", async () => {
    const h = harness(input({ source: { identity: "audio-source", width: 1, height: 1, hasVideo: false } }));
    await h.owner.fulfill(requests.slice(0, 1));
    expect(h.calls.segment).toBe(0);
    expect(h.owner.availability.automaticLayout.state).toBe("available");
  });

  test("background proxy and render share original dimensions, normalized geometry, and zoom policy", async () => {
    const originalPath = "original-1920x1080.mp4";
    const commands: Array<{ args: readonly string[] }> = [];
    const workerProcess: WorkerProcessModule = {
      inspectMedia: async (request) => { expect(request.sourcePath).toBe(originalPath); expect(request.deadlineMs).toBe(120_000); return { durationSec: 30, width: 1920, height: 1080, hasVideo: true, hasAudio: true, hasVisualStream: true, fps: 30 }; },
      execute: async (request) => { commands.push(request); return { exitCode: 0, stdout: Buffer.from(request.command === "ffmpeg" ? "pts_time:5" : JSON.stringify({ samples })) }; },
      withScratchDirectory: async (_prefix, work) => work("unused"),
    };
    const preview = await analyzeClipAutoLayout({
      clip: { id: "clip-1", projectId: "project-1", startSec: 10, endSec: 20, deletedRanges: [], transcriptSlice: [], editorRevision: 7, previewStorageKey: "preview", sourceStorageKey: "source", previewStartSec: 8, previewDurationSec: 14, autoLayoutClaimToken: "claim", leaseMs: 180000 },
      previewPath: "proxy-640x360.mp4", originalSourcePath: originalPath, workerProcess, config: parseRenderConfig({}),
    });
    const rendered = harness(); await rendered.owner.fulfill(requests.slice(0, 1));
    const result = rendered.owner.availability.automaticLayout;
    expect(result.state).toBe("available");
    if (result.state === "available") {
      expect(preview.segments).toEqual(result.value.analysis.segments);
      expect(preview.noSplitSegments).toEqual(result.value.analysis.noSplitSegments);
    }
    expect(preview).toMatchObject({ sourceWidth: 1920, sourceHeight: 1080 });
    const multi = commands.find((command) => command.args.includes("--multi"));
    expect(multi?.args.slice(1)).toEqual(["proxy-640x360.mp4", "2", "10", "4", "/usr/local/share/narriflow/face_yunet.onnx", "--multi"]);
    expect(preview.noSplitSegments.every((segment) => segment.layout !== "single" || segment.zoom <= 2.5)).toBe(true);
  });
});

test("content-only Split failures remain reusable and conclusive no-face Screen evidence is cacheable", async () => {
  const empty = harness();
  empty.dependencies.detectors.detectFacePath = async () => ({ samples: [] });
  empty.dependencies.detectors.detectMultiFacePath = async () => ({ samples: [] });
  await empty.owner.fulfill(requests.slice(1));
  const durable = { screen: empty.writes.find((write) => write.kind === "screen")!.value, split: empty.writes.find((write) => write.kind === "split-failure")!.value };
  const reused = harness(input({ durable })); await reused.owner.fulfill(requests.slice(1));
  expect(reused.owner.availability).toMatchObject({ screenLayout: { state: "available" }, splitLayout: { state: "failed", reason: "insufficient_clusters" } });
  expect(reused.calls.segment).toBe(0); expect(reused.writes).toEqual([]);
});

describe("bounded analysis operations", () => {
  test.each(["segment", "detector"])("rebuilds a failed %s and lets third-operation success win", async (failure) => {
    const delays: number[] = [];
    let executions = 0;
    const transient = new WorkflowFailure("analysis_input_unavailable", "retryable", "temporary failure");
    const h = harness(input(failure === "segment" ? { getSegment: async () => {
      if (++executions < 3) throw transient;
      return { path: "recovered.mp4", startSec: 0, durationSec: 10 };
    } } : {}), { delay: async (ms) => { delays.push(ms); } });
    if (failure === "detector") h.dependencies.detectors.detectMultiFacePath = async () => {
      if (++executions < 3) throw transient;
      return { samples };
    };
    await h.owner.fulfill(requests.slice(0, 1));
    const reference = harness(); await reference.owner.fulfill(requests.slice(0, 1));
    expect(h.owner.availability).toEqual(reference.owner.availability);
    expect(executions).toBe(3);
    expect(delays).toEqual([1000, 2000]);
    expect(h.writes).toEqual(reference.writes);
    expect(h.owner.framingDegraded).toBeUndefined();
  });

  test.each([0, 1, 2])("exhausts exactly three operations and renders center for engine %s", async (engine) => {
    const delays: number[] = [];
    const diagnoses: Array<{ message: string; context: Record<string, unknown> }> = [];
    const h = harness(input(), { delay: async (ms) => { delays.push(ms); }, diagnose: (message, context) => diagnoses.push({ message, context }) });
    let executions = 0;
    const fail = async () => { executions++; throw new WorkflowFailure("worker_command_timeout", "retryable", "timeout"); };
    if (engine === 1) h.dependencies.detectors.detectPipPath = fail;
    else h.dependencies.detectors.detectMultiFacePath = fail;
    await h.owner.fulfill([requests[engine]!]);
    expect(executions).toBe(3);
    expect(delays).toEqual([1000, 2000]);
    expect(h.writes).toEqual([]);
    expect(h.owner.framingDegraded).toMatchObject({ attempts: 3, causeCode: "worker_command_timeout" });
    expect(diagnoses.find((entry) => entry.message === "framing_degraded")?.context).toMatchObject({ attempts: 3, causeCode: "worker_command_timeout", fallbackMode: "center_crop" });
    const mode = ["auto", "screen", "split"][engine]!;
    const document = editorDocumentSchema.parse({ version: 1, clipStartSec: 10, clipEndSec: 20, captionPreset: captionPresetSchema.parse({}), transcriptSlice: [], studioEdits: { framing: { mode } }, brollUrl: null, deletedRanges: [] });
    const planned = planClipComposition({
      document, source: { identity: "source", kind: "video", width: 1920, height: 1080 },
      evidence: deriveRenderCompositionEvidence({ availability: h.owner.availability, sourceIdentity: "source", clipStartSec: 10, clipEndSec: 20, deletedRanges: [], framingDegraded: h.owner.framingDegraded }),
      assets: { backgroundImage: { state: "missing" } }, capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: CLIP_AUTO_LAYOUT_ENGINE },
      targets: [{ id: "portrait", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (planned.status === "invalid") throw new Error(planned.error.code);
    expect(planned.plan.targets[0]?.effectiveMode).toBe("center");
    expect(planned.plan.targets[0]?.scenes[0]?.layers).toHaveLength(1);
    expect(planned.plan.notices).toContainEqual(expect.objectContaining({ code: "framing_degraded", effectiveFallback: "center", attempts: 3, causeCode: "worker_command_timeout" }));
  });

  test("one group budget covers multiple engines and concurrent failures finish before retry", async () => {
    let inFlight = 0; let maximum = 0; let passes = 0;
    const h = harness(input(), { delay: async () => { expect(inFlight).toBe(0); } });
    h.dependencies.detectors.detectMultiFacePath = async () => {
      passes++; if (passes < 2) throw new Error("temporary multi failure"); return { samples };
    };
    h.dependencies.detectors.detectPipPath = async () => { throw new Error("temporary pip failure"); };
    h.dependencies.detectors.detectFacePath = async () => { inFlight++; maximum = Math.max(maximum, inFlight); await Bun.sleep(1); inFlight--; return { samples: [] }; };
    await h.owner.fulfill(requests);
    expect(h.owner.resources.analysisAttempts).toBe(3);
    expect(maximum).toBe(1);
    expect(h.writes.map((write) => write.kind)).toEqual(["automatic"]);
    expect(h.owner.framingDegraded?.modes).toEqual(["screen", "split"]);
  });

  test.each([
    new WorkflowFailure("source_media_invalid", "permanent", "invalid source"),
    new WorkerProcessFailure("worker_command_spawn_failed", "retryable", "spawn", "", null, { failureScope: "executor", errno: "EBADF" }),
    new WorkerProcessFailure("worker_command_unavailable", "retryable", "missing", "", null, { failureScope: "configuration" }),
  ])("propagates source/executor failures before delay or persistence", async (failure) => {
    const h = harness(input({ getSegment: async () => { throw failure; } }), { delay: async () => { throw new Error("must not sleep"); } });
    await expect(h.owner.fulfill(requests)).rejects.toBe(failure);
    expect(h.calls.segment).toBe(1);
    expect(h.writes).toEqual([]);
  });

  test("cancellation during the default backoff stops retries", async () => {
    const controller = new AbortController(); const reason = new Error("ownership lost");
    let calls = 0;
    const h = harness(input({ signal: controller.signal, getSegment: async () => { calls++; setTimeout(() => controller.abort(reason), 10); throw new Error("temporary"); } }), { delay: undefined });
    await expect(h.owner.fulfill(requests)).rejects.toBe(reason);
    expect(calls).toBe(1); expect(h.writes).toEqual([]);
  });
});

test("old transient Screen/Split envelopes cannot short-circuit fresh evidence", async () => {
  const fresh = harness(); await fresh.owner.fulfill(requests);
  const screen = fresh.writes.find((write) => write.kind === "screen")!.value;
  if (!("inputFingerprint" in screen)) throw new Error("expected Screen evidence");
  const split = fresh.writes.find((write) => write.kind === "split")!.value;
  const durable = {
    screen: { version: 1, engine: SCREEN_LAYOUT_ENGINE_VERSION, state: "failed", sourceIdentity: screen.sourceIdentity, inputFingerprint: screen.inputFingerprint, analyzedAtISO: screen.analyzedAtISO, reason: "detection_unavailable" },
    split: { ...split, state: "failed", inputFingerprint: splitLayoutInputFingerprint({ sourceIdentity: split.sourceIdentity, clipStartSec: 10, clipEndSec: 20, deletedRanges: [], engineVersion: "explicit-split-v1" }), reason: "detection_unavailable", segments: undefined, noSplitSegments: undefined },
  };
  const current = harness(input({ durable })); await current.owner.fulfill(requests.slice(1));
  expect(current.calls.segment).toBe(1);
  expect(current.owner.availability.screenLayout.state).toBe("available");
  expect(current.owner.availability.splitLayout.state).toBe("available");
});

test("exhausted scene speaker analysis becomes a center crop with a causal notice", async () => {
  const h = harness(input({ getSegment: async () => { throw new WorkflowFailure("analysis_input_unavailable", "retryable", "input"); } }));
  await h.owner.fulfill(requests.slice(0, 1));
  const document = editorDocumentSchema.parse({ version: 1, clipStartSec: 10, clipEndSec: 20, captionPreset: captionPresetSchema.parse({}), transcriptSlice: [], studioEdits: { framing: { mode: "center" }, sceneLayouts: [{ id: "speaker-scene", aspectRatio: "9:16", startSec: 0, endSec: 10, preset: "screen-top" }] }, brollUrl: null, deletedRanges: [] });
  const planned = planClipComposition({ document, source: { identity: "source", kind: "video", width: 1920, height: 1080 }, evidence: deriveRenderCompositionEvidence({ availability: h.owner.availability, framingDegraded: h.owner.framingDegraded, sourceIdentity: "source", clipStartSec: 10, clipEndSec: 20, deletedRanges: [] }), assets: { backgroundImage: { state: "missing" } }, capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: CLIP_AUTO_LAYOUT_ENGINE }, targets: [{ id: "portrait", aspectRatio: "9:16", width: 1080, height: 1920 }] });
  if (planned.status === "invalid") throw new Error(planned.error.code);
  const layer = planned.plan.targets[0]!.scenes[0]!.layers.find((layer) => layer.kind === "source-video");
  expect(layer?.destination).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  expect(planned.plan.notices).toContainEqual(expect.objectContaining({ code: "framing_degraded", sceneId: "speaker-scene", attempts: 3, causeCode: "analysis_input_unavailable" }));
});
