import { describe, expect, test } from "bun:test";
import { compositionAssetRef, type CompositionEvidenceRequest } from "@narriflow/composition-plan";
import { CLIP_AUTO_LAYOUT_ENGINE, SCREEN_LAYOUT_ENGINE_VERSION } from "@narriflow/validators";
import { LayoutEvidence, type LayoutEvidenceDependencies, type LayoutEvidenceInput, type LayoutEvidenceWrite } from "./layout-evidence";
import { parseRenderConfig } from "./render-config";
import { analyzeClipAutoLayout } from "./tasks/auto-layout-analysis";
import type { WorkerProcessModule } from "./worker-process";

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
    rethrowControl: () => {}, diagnose: () => {}, ...overrides,
  };
  const owner = new LayoutEvidence({ ...value, getSegment: async () => { calls.segment += 1; return value.getSegment(); } }, dependencies);
  return { owner, writes, calls, dependencies };
}

describe("LayoutEvidence", () => {
  test("uses one conservative Automatic zoom policy for landscape, square and portrait originals", async () => {
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
        expect(segment.topZoom).toBe(1.1);
        expect(segment.bottomZoom).toBe(1.1);
        expect(segment.topCropTrack?.[0]?.cyNorm).toBe(segment.topCyNorm);
        expect(segment.bottomCropTrack?.[0]?.cyNorm).toBe(segment.bottomCyNorm);
      }
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
    expect(h.calls).toEqual({ segment: 1, multi: 0, face: 0, pip: 0, cuts: 0 });
    expect(h.writes.some((write) => write.kind === "automatic")).toBe(false);
  });

  test("memoizes a failed segment and represents unavailable detection separately from conclusive no-face evidence", async () => {
    const unavailable = harness(input({ getSegment: async () => { throw new Error("range unavailable"); } }));
    await unavailable.owner.fulfill(requests);
    expect(unavailable.calls.segment).toBe(1);
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
    expect(preview.noSplitSegments.every((segment) => segment.layout !== "single" || segment.zoom <= 1.25)).toBe(true);
  });
});

test("matching durable Screen and Split failures reuse typed degradation without detectors", async () => {
  const failed = harness();
  failed.dependencies.detectors.detectFacePath = async () => null;
  failed.dependencies.detectors.detectPipPath = async () => null;
  failed.dependencies.detectors.detectMultiFacePath = async () => null;
  await failed.owner.fulfill(requests.slice(1));
  const durable = { screen: failed.writes.find((write) => write.kind === "screen-failure")!.value, split: failed.writes.find((write) => write.kind === "split-failure")!.value };
  const reused = harness(input({ durable }));
  expect(await reused.owner.fulfill(requests.slice(1))).toMatchObject({ screenLayout: { state: "failed", reason: "detection_unavailable" }, splitLayout: { state: "failed", reason: "detection_unavailable" } });
  expect(reused.calls.segment).toBe(0);
  expect(reused.writes).toEqual([]);
  const changed = input({ durable }); changed.clip = { ...changed.clip, endSec: 19 };
  const stale = harness(changed); await stale.owner.fulfill(requests.slice(1));
  expect(stale.calls.segment).toBe(1);
});
