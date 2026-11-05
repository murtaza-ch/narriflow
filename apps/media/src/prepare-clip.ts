import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { compositionAssetRef, screenLayoutInputFingerprint, splitLayoutInputFingerprint, type CompositionEvidenceRequest } from "@narriflow/composition-plan";
import { encodeClipPreparationInput, encodeClipPreparationResult } from "@narriflow/services/clip-preparation-input";
import { CLIP_PREPARATION_POLICY, clipPreparationEngineHash, clipPreparationTiming, clipPreparationPreviewWindow } from "@narriflow/services/clip-preparation-policy";
import { CLIP_AUTO_LAYOUT_ENGINE, SCREEN_LAYOUT_ENGINE_VERSION, SCREEN_LAYOUT_VERSION, clipLayoutAnalysisFailureSchema, clipSplitLayoutFailureSchema, sourceProbeSchema } from "@narriflow/validators";
import type { ClipPreparationInput, ClipPreparationResult } from "@narriflow/validators/clip-preparation";
import { LayoutEvidence, type LayoutDetectionInput, type LayoutEvidenceDetectors, type LayoutEvidenceWrite } from "./layout-evidence";
import { createLayoutEvidenceDetectors } from "./layout-evidence-runtime";
import { hdrColorOf } from "./composition-ffmpeg-adapter";
import type { RenderConfig } from "./render-config";
import { renderEncodeDeadlineMs } from "./render-resource-budget";
import { executorProcessFailure, resolveDisplayGeometry, type WorkerProcessModule } from "./worker-process";
import { buildAudiogramPreviewArgs, buildClipPreviewArgs, clipPreviewOutputExpectation, encodeAndValidateClipPreview, generateClipPreviewPeaks } from "./tasks/clip-preview";
import { renderFfmpegArgs } from "./ffmpeg-thread-policy";

/** Source observations are prepared once. Optional B-roll's application gate
 * remains with the renderer after its actual native asset validation. */
export async function prepareClip(options: {
  input: ClipPreparationInput; sourcePath: string; work: string;
  previewArtifactId: string; peaksArtifactId: string;
  workerProcess: WorkerProcessModule; config: Readonly<RenderConfig>; signal: AbortSignal;
  detectors?: LayoutEvidenceDetectors;
}) {
  const { input } = await encodeClipPreparationInput(options.input);
  if (input.engineHash !== await clipPreparationEngineHash(input.toolchainFingerprint)) throw new Error("clip_preparation_engine_invalid");
  const { signal } = options;
  const native = options.workerProcess;
  const phaseMs: Record<string, number> = {};
  const timed = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    try { return await work(); } finally { phaseMs[phase] = (phaseMs[phase] ?? 0) + Math.round(performance.now() - startedAt); }
  };
  const workerProcess: WorkerProcessModule = {
    execute: request => native.execute({ ...request, args: basename(request.command) === "ffmpeg" ? renderFfmpegArgs(request.args) : request.args }),
    inspectMedia: native.inspectMedia.bind(native), withScratchDirectory: native.withScratchDirectory.bind(native),
  };
  const policy = CLIP_PREPARATION_POLICY;
  const config = { ...options.config, reframeSampleFps: policy.observations.sampleFps, reframeSceneThreshold: policy.observations.sceneThreshold,
    pipMotionThreshold: policy.observations.pipMotionThreshold, probeCommandTimeoutMs: policy.observations.probeTimeoutMs,
    reframePython: policy.observations.python, reframeModelPath: policy.observations.modelPath };
  signal.throwIfAborted();
  const probe = await timed("probe", () => workerProcess.inspectMedia({ sourcePath: options.sourcePath, signal, deadlineMs: config.probeCommandTimeoutMs }));
  if (JSON.stringify(sourceProbeSchema.parse(probe.sourceProbe)) !== JSON.stringify(sourceProbeSchema.parse(input.sourceProbe))) throw new Error("source_identity_mismatch");
  const window = clipPreparationPreviewWindow(input), timing = clipPreparationTiming(input);
  if (window.durationSec <= 0) throw new Error("clip_preparation_window_invalid");
  const previewPath = join(options.work, "preview.mp4"), layoutPath = join(options.work, "layout.json");
  const geometry = resolveDisplayGeometry(probe);
  const expected = clipPreviewOutputExpectation(probe, window, policy.preview.maxHeight);
  const shared = { sourcePath: options.sourcePath, outputPath: previewPath, windowStartSec: window.startSec, windowDurationSec: window.durationSec, ...policy.preview };
  const args = probe.hasVideo ? buildClipPreviewArgs({ ...shared, hasAudio: probe.hasAudio, frameRate: expected.frameRate,
    ...(geometry.anamorphic ? { squarePixelAspect: geometry.width / geometry.height } : {}) })
    : buildAudiogramPreviewArgs({ ...shared, captionPreset: input.document.captionPreset });
  const deadlineMs = renderEncodeDeadlineMs({ editedDurationSec: window.durationSec, sourceWidth: probe.width, sourceHeight: probe.height, hdr: hdrColorOf(probe) !== null }, config);
  await timed("preview", () => encodeAndValidateClipPreview({ workerProcess, signal, args, outputPath: previewPath, expected, deadlineMs }));
  let peaksPath: string | null = null;
  if (probe.hasAudio) {
    try {
      const peaks = await timed("peaks", () => generateClipPreviewPeaks({ workerProcess, signal, proxyFilePath: previewPath,
        windowStartSec: window.startSec, windowDurationSec: window.durationSec, settings: policy.peaks }));
      peaksPath = join(options.work, "preview.peaks.json");
      await writeFile(peaksPath, JSON.stringify(peaks));
    } catch (error) {
      signal.throwIfAborted();
      if (executorProcessFailure(error)) throw error;
    }
  }
  const sourceIdentity = compositionAssetRef("source", input.projectId);
  const writes: LayoutEvidenceWrite[] = [];
  const detectors = options.detectors ?? createLayoutEvidenceDetectors({ workerProcess, config, signal });
  const evidence = new LayoutEvidence({
    source: { identity: sourceIdentity, hasVideo: probe.hasVideo, width: geometry.width || 1, height: geometry.height || 1 },
    clip: { id: input.clipId, startSec: timing.startSec, endSec: timing.endSec, deletedRanges: input.document.deletedRanges,
      utterances: timing.transcriptSlice, editorRevision: input.editorRevision, previewStorageKey: null },
    durable: {}, enabled: { automatic: true, screen: probe.hasVideo, split: probe.hasVideo },
    hasBroll: false, preparationPreviewArtifactId: options.previewArtifactId, pipMotionThreshold: config.pipMotionThreshold, signal,
    sceneSource: { path: options.sourcePath, startSec: timing.startSec },
    getSegment: async () => ({ path: previewPath, startSec: Math.max(0, timing.startSec-window.startSec),
      durationSec: Math.max(0, window.durationSec-Math.max(0, timing.startSec-window.startSec)) }),
  }, {
    detectors: {
      detectFacePath: (request: LayoutDetectionInput) => timed("faces", () => detectors.detectFacePath(request)),
      detectMultiFacePath: (request: LayoutDetectionInput) => timed("multiFaces", () => detectors.detectMultiFacePath(request)),
      detectPipPath: (request: LayoutDetectionInput) => timed("pip", () => detectors.detectPipPath(request)),
      detectSceneCuts: (request: LayoutDetectionInput) => timed("sceneCuts", () => detectors.detectSceneCuts(request)),
    },
    persist: async write => { writes.push(write); return true; }, now: Date.now,
    rethrowControl: () => signal.throwIfAborted(), diagnose: () => {},
  });
  const requests: CompositionEvidenceRequest[] = [{ key: "automatic", kind: "automatic-speaker-layout", engineVersion: CLIP_AUTO_LAYOUT_ENGINE }];
  if (probe.hasVideo) requests.push({ key: "screen", kind: "screen-layout", engineVersion: SCREEN_LAYOUT_ENGINE_VERSION },
    { key: "split", kind: "split-speaker-layout", engineVersion: "explicit-split-v1" });
  await evidence.fulfill(requests);
  const automatic = writes.find(write => write.kind === "automatic"), screen = writes.find(write => write.kind === "screen" || write.kind === "screen-failure"), split = writes.find(write => write.kind === "split" || write.kind === "split-failure");
  const binding = { sourceIdentity, clipStartSec: timing.startSec, clipEndSec: timing.endSec, deletedRanges: input.document.deletedRanges };
  const unavailable = { state: "failed" as const, sourceIdentity, analyzedAtISO: new Date().toISOString() };
  const screenState = evidence.availability.screenLayout, splitState = evidence.availability.splitLayout;
  const screenReason = clipLayoutAnalysisFailureSchema.shape.reason.safeParse(screenState.state === "failed" ? screenState.reason : undefined);
  const splitReason = clipSplitLayoutFailureSchema.shape.reason.safeParse(splitState.state === "failed" ? splitState.reason : undefined);
  const result: ClipPreparationResult = {
    version: 1, preparationId: input.preparationId, bindingHash: input.bindingHash,
    preview: { artifactId: options.previewArtifactId, startSec: window.startSec, durationSec: window.durationSec },
    peaks: peaksPath ? { state: "ready", artifactId: options.peaksArtifactId } : { state: "unavailable", reason: probe.hasAudio ? "peaks_unavailable" : "no_audio" },
    layout: {
      automatic: automatic ? { ...automatic.value, analysisPath: "proxy" } : { state: "failed", reason: "analysis_unavailable" },
      screen: !probe.hasVideo ? null : screen?.value ?? { ...unavailable, version: SCREEN_LAYOUT_VERSION, engine: SCREEN_LAYOUT_ENGINE_VERSION,
        inputFingerprint: screenLayoutInputFingerprint({ ...binding, engineVersion: SCREEN_LAYOUT_ENGINE_VERSION }), reason: screenReason.success ? screenReason.data : "analysis_unavailable" },
      split: !probe.hasVideo ? null : split?.value ?? { ...unavailable, version: 1, engine: "explicit-split-v1",
        inputFingerprint: splitLayoutInputFingerprint({ ...binding, engineVersion: "explicit-split-v1" }), reason: splitReason.success ? splitReason.data : "detection_unavailable" },
    },
  };
  const encoded = await encodeClipPreparationResult(result);
  await writeFile(layoutPath, encoded.bytes);
  return { previewPath, peaksPath, layoutPath, result: encoded.result, phaseMs };
}
