import {
  automaticLayoutInputFingerprint,
  screenLayoutInputFingerprint,
  splitLayoutInputFingerprint,
  type AutomaticLayoutEvidenceAvailability,
  type CompositionEvidenceAvailability,
  type CompositionEvidenceRequest,
  type ScreenLayoutEvidence,
  type ScreenLayoutFailureReason,
  type SplitLayoutEvidence,
  type SplitLayoutFailureReason,
} from "@narriflow/composition-plan";
import {
  CLIP_AUTO_LAYOUT_ENGINE,
  CLIP_AUTO_LAYOUT_VERSION,
  SCREEN_LAYOUT_ENGINE_VERSION,
  clipAutoLayoutAnalysisSchema,
  clipAutoLayoutMatchesInputs,
  clipLayoutAnalysisFailureSchema,
  clipLayoutAnalysisV2Schema,
  clipSplitLayoutFailureSchema,
  parseClipAutoLayoutAnalysis,
  parseClipLayoutAnalysis,
  parseClipLayoutAnalysisFailure,
  parseClipSplitLayoutAnalysis,
  parseClipSplitLayoutFailure,
  sourceToEdited,
  type ClipAutoLayoutAnalysis,
  type ClipLayoutAnalysis,
  type ClipLayoutAnalysisFailure,
  type ClipSplitLayoutAnalysis,
  type ClipSplitLayoutFailure,
  type ClipSplitLayoutSegment,
  type SourceRange,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { automaticLayoutFrameOptions } from "./tasks/auto-layout-zoom";
import { buildClipCutPlan, type ClipCutPlan } from "./tasks/cut-plan";
import { buildAutoLayoutPlan, speechWordsFromUtterances } from "./tasks/layout-engine";
import { remapFaceSamplesForCutPlan, smoothFacePath, type FaceSample, type SmoothedSample } from "./tasks/reframe";
import { classifyScreencast, confirmsFaceInRect, selectPipRect, type PipCandidate, type PipRect } from "./tasks/screen-layout";
import { buildSplitLayoutPlan, deriveSingleFaceSamplesFromMulti, remapMultiFaceSamplesForCutPlan, type BuildSplitLayoutPlanResult, type MultiFaceSample } from "./tasks/two-up";

export interface LayoutDetectionInput {
  sourcePath: string;
  startSec: number;
  durationSec: number;
  logContext?: Record<string, unknown>;
}

export interface PipDetectionResult {
  movingPxFrac: number | null;
  insufficientSamples: boolean;
  candidates: PipCandidate[];
}

export interface LayoutEvidenceDetectors {
  detectFacePath(input: LayoutDetectionInput): Promise<{ samples: FaceSample[] } | null>;
  detectMultiFacePath(input: LayoutDetectionInput): Promise<{ samples: MultiFaceSample[] } | null>;
  detectPipPath(input: LayoutDetectionInput): Promise<PipDetectionResult | null>;
  detectSceneCuts(input: LayoutDetectionInput): Promise<number[]>;
}

/** Detector coordinates are normalized against the analysis frame, while
 * envelopes and zoom policy always use the original source's dimensions. */
export interface LayoutEvidenceInput {
  source: { identity: string; width: number; height: number; hasVideo: boolean };
  clip: {
    id: string;
    startSec: number;
    endSec: number;
    deletedRanges: SourceRange[];
    utterances: TranscriptUtterance[];
    editorRevision: number;
    previewStorageKey: string | null;
  };
  durable: { automatic?: unknown; screen?: unknown; split?: unknown };
  enabled: { automatic: boolean; screen: boolean; split: boolean };
  hasBroll: boolean;
  pipMotionThreshold: number;
  signal: AbortSignal;
  /** The returned local media must cover the whole uncut Clip window. */
  getSegment(): Promise<{ path: string; startSec: number; durationSec: number } | null>;
}

export type LayoutEvidenceWrite =
  | { kind: "automatic"; value: ClipAutoLayoutAnalysis }
  | { kind: "screen"; value: ClipLayoutAnalysis }
  | { kind: "screen-failure"; value: ClipLayoutAnalysisFailure }
  | { kind: "split"; value: ClipSplitLayoutAnalysis }
  | { kind: "split-failure"; value: ClipSplitLayoutFailure };

export interface LayoutEvidenceDependencies {
  detectors: LayoutEvidenceDetectors;
  /** Adapter fences the write by the frozen revision, preview and owner claim.
   * A false result skips the durable write; frozen render evidence stays usable. */
  persist(write: LayoutEvidenceWrite, clip: LayoutEvidenceInput["clip"]): Promise<boolean | undefined>;
  now(): number;
  /** Preserve caller-specific ownership control signals before degrading IO. */
  rethrowControl(error: unknown): void;
  diagnose(message: string, context: Record<string, unknown>): void;
}

export interface LayoutEvidenceAvailability {
  automaticLayout: AutomaticLayoutEvidenceAvailability;
  screenLayout: CompositionEvidenceAvailability<ScreenLayoutEvidence, ScreenLayoutFailureReason>;
  splitLayout: CompositionEvidenceAvailability<SplitLayoutEvidence, SplitLayoutFailureReason>;
}

/** One Clip snapshot owns reuse, detection, envelope construction and durable
 * publication for every layout engine. Both background analysis and render
 * consume this interface; composition decisions remain in the planner. */
export class LayoutEvidence {
  readonly availability: LayoutEvidenceAvailability;
  readonly resources = { requestKeys: new Set<string>(), analysisExecutionCount: 0, detectorExecutionCount: 0, persistenceFailures: 0, persistenceSkipped: 0 };
  automaticSource: "durable" | "analysis" | "failed" | "disabled";
  private readonly cutPlan: ClipCutPlan;
  private readonly durationSec: number;
  private readonly rawDurationSec: number;
  private segmentPromise: Promise<{ path: string; startSec: number } | null> | undefined;
  private multiPromise: Promise<{ samples: MultiFaceSample[] } | null> | undefined;
  private readonly fulfilled = new Set<string>();

  constructor(private readonly input: LayoutEvidenceInput, private readonly deps: LayoutEvidenceDependencies) {
    this.checkpoint();
    const { source, clip } = input;
    if (!Number.isInteger(source.width) || source.width <= 0 || !Number.isInteger(source.height) || source.height <= 0) throw new Error("layout evidence requires original source dimensions");
    this.rawDurationSec = clip.endSec - clip.startSec;
    this.cutPlan = buildClipCutPlan(clip.deletedRanges, { startSec: clip.startSec, endSec: clip.endSec });
    this.durationSec = this.cutPlan.isUncut ? this.rawDurationSec : this.cutPlan.editedDurationSec;
    if (this.cutPlan.isEmpty || this.durationSec <= 0) throw new Error("clip has no renderable duration");
    this.availability = {
      automaticLayout: { state: input.enabled.automatic ? "missing" : "disabled" },
      screenLayout: { state: input.enabled.screen ? "missing" : "disabled" },
      splitLayout: { state: input.enabled.split ? "missing" : "disabled" },
    };
    this.automaticSource = input.enabled.automatic ? "failed" : "disabled";
    const automatic = parseClipAutoLayoutAnalysis(input.durable.automatic);
    if (input.enabled.automatic && automatic && this.matchesEnvelope(automatic)) {
      this.setAutomatic(automatic, "durable");
    }
    const screen = parseClipLayoutAnalysis(input.durable.screen);
    if (input.enabled.screen && !input.hasBroll && screen && this.matchesScreen(screen)) this.setScreen(screen, "durable-pip");
    const screenFailure = parseClipLayoutAnalysisFailure(input.durable.screen);
    if (input.enabled.screen && !screen && screenFailure?.sourceIdentity === source.identity && screenFailure.inputFingerprint === this.fingerprint(SCREEN_LAYOUT_ENGINE_VERSION, "screen")) this.availability.screenLayout = { state: "failed", reason: screenFailure.reason };
    const split = parseClipSplitLayoutAnalysis(input.durable.split);
    if (input.enabled.split && !input.hasBroll && split && this.matchesEnvelope(split)) this.setSplit(split, "durable-explicit");
    const splitFailure = parseClipSplitLayoutFailure(input.durable.split);
    if (input.enabled.split && !split && splitFailure?.sourceIdentity === source.identity && splitFailure.inputFingerprint === this.fingerprint("explicit-split-v1", "split")) this.availability.splitLayout = { state: "failed", reason: splitFailure.reason };
  }

  async fulfill(requests: readonly CompositionEvidenceRequest[]): Promise<LayoutEvidenceAvailability> {
    for (const request of requests) {
      this.checkpoint();
      const engine = request.kind === "automatic-speaker-layout" ? CLIP_AUTO_LAYOUT_ENGINE : request.kind === "screen-layout" ? SCREEN_LAYOUT_ENGINE_VERSION : "explicit-split-v1";
      if (request.engineVersion !== engine) throw new Error("unsupported_clip_composition_evidence_version");
      if (this.fulfilled.has(request.kind)) continue;
      this.fulfilled.add(request.kind);
      const state = request.kind === "automatic-speaker-layout" ? this.availability.automaticLayout : request.kind === "screen-layout" ? this.availability.screenLayout : this.availability.splitLayout;
      if (state.state === "available" || state.state === "disabled" || state.state === "failed") continue;
      if (this.input.hasBroll && request.kind !== "automatic-speaker-layout") {
        if (request.kind === "screen-layout") this.availability.screenLayout = { state: "failed", reason: "broll_conflict" };
        else this.availability.splitLayout = { state: "failed", reason: "broll_conflict" };
        continue;
      }
      this.resources.requestKeys.add(request.key);
      this.resources.analysisExecutionCount += 1;
      if (request.kind === "automatic-speaker-layout") await this.automatic();
      else if (request.kind === "screen-layout") await this.screen();
      else await this.split();
    }
    this.checkpoint();
    return this.availability;
  }

  private checkpoint(): void { this.input.signal.throwIfAborted(); }
  private fingerprint(engineVersion: string, kind: "automatic" | "screen" | "split"): string {
    const value = { sourceIdentity: this.input.source.identity, clipStartSec: this.input.clip.startSec, clipEndSec: this.input.clip.endSec, deletedRanges: this.input.clip.deletedRanges, engineVersion };
    return kind === "automatic" ? automaticLayoutInputFingerprint(value) : kind === "screen" ? screenLayoutInputFingerprint(value) : splitLayoutInputFingerprint(value);
  }
  private matchesEnvelope(value: ClipAutoLayoutAnalysis | ClipSplitLayoutAnalysis): boolean {
    return value.sourceIdentity === this.input.source.identity && value.sourceWidth === this.input.source.width && value.sourceHeight === this.input.source.height && clipAutoLayoutMatchesInputs(value, { clipStartSec: this.input.clip.startSec, clipEndSec: this.input.clip.endSec, deletedRanges: this.input.clip.deletedRanges }) && Math.abs(value.editedDurationSec - this.durationSec) <= 0.075;
  }
  private matchesScreen(value: ClipLayoutAnalysis): boolean {
    return value.sourceIdentity === this.input.source.identity && value.sourceWidth === this.input.source.width && value.sourceHeight === this.input.source.height && value.inputFingerprint === this.fingerprint(SCREEN_LAYOUT_ENGINE_VERSION, "screen") && layoutAnalysisMatchesWindow(value, this.input.clip.startSec, this.rawDurationSec);
  }
  private setAutomatic(value: ClipAutoLayoutAnalysis, source: "durable" | "analysis"): void {
    this.automaticSource = source;
    this.availability.automaticLayout = { state: "available", value: { sourceIdentity: this.input.source.identity, inputFingerprint: this.fingerprint(CLIP_AUTO_LAYOUT_ENGINE, "automatic"), engineVersion: CLIP_AUTO_LAYOUT_ENGINE, analysis: value } };
  }
  private setScreen(value: ClipLayoutAnalysis, source: "durable-pip" | "analysis"): void {
    this.availability.screenLayout = { state: "available", value: { sourceIdentity: this.input.source.identity, inputFingerprint: this.fingerprint(SCREEN_LAYOUT_ENGINE_VERSION, "screen"), engineVersion: SCREEN_LAYOUT_ENGINE_VERSION, source, pictureInPicture: value.pipUsable && value.pipRect ? { state: "confirmed", rect: { x: value.pipRect.x, y: value.pipRect.y, width: value.pipRect.w, height: value.pipRect.h } } : { state: "unavailable" }, faceBand: value.faceBandSegments ? { state: "available", segments: value.faceBandSegments } : { state: "unavailable" } } };
  }
  private setSplit(value: ClipSplitLayoutAnalysis, source: "durable-explicit" | "explicit-detector"): void {
    this.availability.splitLayout = { state: "available", value: { sourceIdentity: this.input.source.identity, inputFingerprint: this.fingerprint("explicit-split-v1", "split"), engineVersion: "explicit-split-v1", source, segments: value.segments, fallbackSegments: value.noSplitSegments } };
  }
  private async segment(): Promise<{ path: string; startSec: number } | null> {
    this.checkpoint();
    this.segmentPromise ??= this.input.getSegment().then((segment) => {
      this.checkpoint();
      // Never stamp full-window identity onto partially covered preview facts.
      if (segment && segment.durationSec + 0.05 >= this.rawDurationSec) return segment;
      this.deps.diagnose("layout_evidence_input_unavailable", { clipId: this.input.clip.id, reason: segment ? "partial_clip_coverage" : "segment_unavailable" });
      return null;
    }).catch((error) => { this.control(error); this.deps.diagnose("clip_reframe_segment_extract_failed", { clipId: this.input.clip.id, phase: "media_analysis", analysisMode: "segment_extraction", failureCode: "analysis_input_unavailable", disposition: "degraded" }); return null; });
    return this.segmentPromise;
  }
  private control(error: unknown): void { this.checkpoint(); this.deps.rethrowControl(error); }
  private async detect<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    this.checkpoint();
    this.resources.detectorExecutionCount += 1;
    try { const value = await work(); this.checkpoint(); return value; }
    catch (error) { this.control(error); this.deps.diagnose("layout_evidence_detection_unavailable", { clipId: this.input.clip.id }); return fallback; }
  }
  private detectionInput(segment: { path: string; startSec: number }): LayoutDetectionInput { return { sourcePath: segment.path, startSec: segment.startSec, durationSec: this.rawDurationSec, logContext: { clipId: this.input.clip.id } }; }
  private multi(segment: { path: string; startSec: number }): Promise<{ samples: MultiFaceSample[] } | null> {
    this.multiPromise ??= this.detect(() => this.deps.detectors.detectMultiFacePath(this.detectionInput(segment)), null);
    return this.multiPromise;
  }
  private async persist(write: LayoutEvidenceWrite): Promise<void> {
    if (!this.input.clip.previewStorageKey) return;
    this.checkpoint();
    try {
      const stored = await this.deps.persist(write, this.input.clip);
      this.checkpoint();
      if (stored === false) this.resources.persistenceSkipped += 1;
    } catch (error) {
      this.control(error);
      this.resources.persistenceFailures += 1;
      this.deps.diagnose("layout_evidence_persist_failed", { clipId: this.input.clip.id, kind: write.kind, phase: "media_analysis", failureCode: "analysis_persist_failed" });
    }
  }
  private envelopeBase() { return { sourceIdentity: this.input.source.identity, analyzedAtISO: new Date(this.deps.now()).toISOString(), clipStartSec: this.input.clip.startSec, clipEndSec: this.input.clip.endSec, deletedRanges: this.input.clip.deletedRanges, editedDurationSec: this.durationSec, sourceWidth: this.input.source.width, sourceHeight: this.input.source.height }; }

  private async automatic(): Promise<void> {
    let samples: MultiFaceSample[] = [];
    let cuts: number[] = [];
    if (this.input.source.hasVideo) {
      const segment = await this.segment();
      if (!segment) { this.availability.automaticLayout = { state: "failed" }; return; }
      const [multi, sceneCuts] = await Promise.all([this.multi(segment), this.detect(() => this.deps.detectors.detectSceneCuts(this.detectionInput(segment)), [])]);
      if (!multi) { this.availability.automaticLayout = { state: "failed" }; return; }
      samples = remapMultiFaceSamplesForCutPlan(multi.samples, this.cutPlan, this.input.clip.startSec);
      cuts = remapSceneCutsForCutPlan(sceneCuts, this.cutPlan, this.input.clip.startSec);
    }
    const base = { samples, sceneCuts: cuts, words: speechWordsFromUtterances(this.input.clip.utterances, this.cutPlan, this.input.clip.startSec, this.input.clip.endSec), durationSec: this.durationSec, options: { frameOptions: automaticLayoutFrameOptions(), activeSpeakerCuts: false } };
    const full = buildAutoLayoutPlan({ ...base, allowTwoUp: true });
    const noSplit = buildAutoLayoutPlan({ ...base, allowTwoUp: false });
    const value = clipAutoLayoutAnalysisSchema.parse({ ...this.envelopeBase(), version: CLIP_AUTO_LAYOUT_VERSION, engine: CLIP_AUTO_LAYOUT_ENGINE, segments: full.segments, noSplitSegments: noSplit.segments, shotCount: full.shotCount, soloShotCount: full.soloShotCount, multiShotCount: full.multiShotCount, twoUpSegmentCount: full.twoUpSegmentCount, speakerCount: full.speakerCount, mappedSpeakerCount: full.mappedSpeakerCount });
    await this.persist({ kind: "automatic", value });
    this.setAutomatic(value, "analysis");
    this.deps.diagnose(full.segments.length ? "clip_layout_plan_applied" : "clip_layout_plan_fallback", { clipId: this.input.clip.id, phase: "media_analysis", analysisMode: "layout_engine", failureCode: full.segments.length ? undefined : "no_trustworthy_faces", durationMs: 0 });
  }
  private async screen(): Promise<void> {
    if (this.input.hasBroll) { this.availability.screenLayout = { state: "failed", reason: "broll_conflict" }; return; }
    const segment = await this.segment();
    const [pip, face] = segment ? await Promise.all([this.detect(() => this.deps.detectors.detectPipPath(this.detectionInput(segment)), null), this.detect(() => this.deps.detectors.detectFacePath(this.detectionInput(segment)), null)]) : [null, null];
    if (!pip || !face) {
      const reason = pip ? "analysis_unavailable" : "detection_unavailable";
      this.availability.screenLayout = { state: "failed", reason };
      this.deps.diagnose("clip_screen_pip_fallback", { clipId: this.input.clip.id, phase: "media_analysis", analysisMode: "picture_in_picture", fallbackMode: "speaker_band", failureCode: reason, disposition: "degraded", durationMs: 0 });
      await this.persist({ kind: "screen-failure", value: clipLayoutAnalysisFailureSchema.parse({ version: 2, engine: SCREEN_LAYOUT_ENGINE_VERSION, state: "failed", sourceIdentity: this.input.source.identity, inputFingerprint: this.fingerprint(SCREEN_LAYOUT_ENGINE_VERSION, "screen"), analyzedAtISO: new Date(this.deps.now()).toISOString(), reason }) });
      return;
    }
    const rect = selectPipRect(pip.candidates);
    const decision = decidePipUsage({ segmentExtracted: true, detection: pip, selectedRect: rect, faceConfirmed: confirmsFaceInRect(face.samples, rect), screencastThreshold: this.input.pipMotionThreshold });
    this.deps.diagnose(decision.useRect ? "clip_screen_pip_selected" : "clip_screen_pip_fallback", { clipId: this.input.clip.id, phase: "media_analysis", analysisMode: "picture_in_picture", selectedMode: decision.useRect ? "pip_crop" : undefined, fallbackMode: decision.useRect ? undefined : "speaker_band", failureCode: decision.useRect ? undefined : decision.reason, disposition: decision.useRect ? "available" : "degraded", analysisSource: "fresh", durationMs: 0 });
    const value = clipLayoutAnalysisV2Schema.parse({ ...this.envelopeBase(), version: 2, engine: SCREEN_LAYOUT_ENGINE_VERSION, inputFingerprint: this.fingerprint(SCREEN_LAYOUT_ENGINE_VERSION, "screen"), sourceStartSec: this.input.clip.startSec, sourceDurationSec: this.rawDurationSec, movingPxFrac: pip.movingPxFrac, insufficientSamples: pip.insufficientSamples, pipRect: rect, pipUsable: decision.useRect, faceBandSegments: faceBandSegmentsForCompositionPlan({ samples: face.samples, cutPlan: this.cutPlan, clipStartSec: this.input.clip.startSec, editedDurationSec: this.durationSec }) });
    await this.persist({ kind: "screen", value });
    this.setScreen(value, "analysis");
  }
  private async split(): Promise<void> {
    if (this.input.hasBroll) { this.availability.splitLayout = { state: "failed", reason: "broll_conflict" }; return; }
    const segment = await this.segment();
    const multi = segment ? await this.multi(segment) : null;
    const plan = multi ? buildSplitLayoutPlan(remapMultiFaceSamplesForCutPlan(multi.samples, this.cutPlan, this.input.clip.startSec), this.durationSec) : null;
    const reason = decideSplitFallback({ hasBrollPlan: false, detectionAvailable: Boolean(multi), plan });
    if (reason || !plan) {
      const failure = reason ?? "empty_plan";
      this.availability.splitLayout = { state: "failed", reason: failure };
      await this.persist({ kind: "split-failure", value: clipSplitLayoutFailureSchema.parse({ version: 1, engine: "explicit-split-v1", state: "failed", sourceIdentity: this.input.source.identity, inputFingerprint: this.fingerprint("explicit-split-v1", "split"), analyzedAtISO: new Date(this.deps.now()).toISOString(), reason: failure }) });
      return;
    }
    const segments = plan.segments.map((segment) => segment.layout === "single" ? { ...segment, cyNorm: segment.cyNorm ?? 0.5, zoom: segment.zoom ?? 1 } : { ...segment, topCyNorm: segment.topCyNorm ?? 0.5, bottomCyNorm: segment.bottomCyNorm ?? 0.5, topZoom: segment.topZoom ?? 1, bottomZoom: segment.bottomZoom ?? 1 });
    const noSplitSegments = faceBandSegmentsForCompositionPlan({ samples: multi ? deriveSingleFaceSamplesFromMulti(multi.samples) : null, cutPlan: this.cutPlan, clipStartSec: this.input.clip.startSec, editedDurationSec: this.durationSec }) ?? [{ startSec: 0, endSec: this.durationSec, layout: "single", cxNorm: 0.5, cyNorm: 0.5, zoom: 1 }];
    const twoUp = segments.filter((segment) => segment.layout === "two-up").length;
    const value = parseClipSplitLayoutAnalysis({ ...this.envelopeBase(), version: 1, engine: "explicit-split-v1", segments, noSplitSegments, shotCount: segments.length, soloShotCount: segments.length - twoUp, multiShotCount: twoUp, twoUpSegmentCount: twoUp, speakerCount: plan.clusterCount, mappedSpeakerCount: plan.clusterCount });
    if (!value) throw new Error("invalid_split_layout_analysis");
    await this.persist({ kind: "split", value });
    this.setSplit(value, "explicit-detector");
    this.deps.diagnose("clip_split_applied", { clipId: this.input.clip.id, phase: "media_analysis", analysisMode: "split_layout", selectedMode: "two_up", durationMs: 0 });
  }
}

function remapSceneCutsForCutPlan(
  cuts: number[],
  cutPlan: ClipCutPlan,
  clipStartSec: number,
): number[] {
  if (cutPlan.isUncut) {


    return [...new Set(cuts.map((t) => Math.round(t * 1000) / 1000))].sort(
      (a, b) => a - b,
    );
  }
  const out: number[] = [];
  for (const cut of cuts) {
    const sourceSec = clipStartSec + cut;
    const segment = cutPlan.segments.find(
      (s) => sourceSec >= s.sourceStartSec && sourceSec <= s.sourceEndSec,
    );
    if (!segment) continue;
    out.push(sourceToEdited(cutPlan.map, sourceSec));
  }
  for (const segment of cutPlan.segments.slice(1)) {
    out.push(segment.editedStartSec);
  }
  return [...new Set(out.map((t) => Math.round(t * 1000) / 1000))].sort(
    (a, b) => a - b,
  );
}


type PipUsageReason =
  | "segment_extract_failed"
  | "detection_unavailable"
  | "insufficient_samples"
  | "not_screencast_like"
  | "no_candidate"
  | "face_not_in_rect"
  | "ok";

interface DecidePipUsageParams {
  
  segmentExtracted: boolean;
  
  detection: {
    movingPxFrac: number | null;
    insufficientSamples: boolean;
  } | null;
  
  screencastThreshold?: number;
  
  selectedRect: PipRect | null;
  
  faceConfirmed: boolean;
}


function decidePipUsage(
  params: DecidePipUsageParams,
): { useRect: boolean; reason: PipUsageReason } {
  if (!params.segmentExtracted) return { useRect: false, reason: "segment_extract_failed" };
  if (!params.detection) return { useRect: false, reason: "detection_unavailable" };
  if (params.detection.insufficientSamples || params.detection.movingPxFrac === null) {
    return { useRect: false, reason: "insufficient_samples" };
  }
  if (!classifyScreencast(params.detection.movingPxFrac, params.screencastThreshold)) {
    return { useRect: false, reason: "not_screencast_like" };
  }
  if (!params.selectedRect) return { useRect: false, reason: "no_candidate" };
  if (!params.faceConfirmed) return { useRect: false, reason: "face_not_in_rect" };
  return { useRect: true, reason: "ok" };
}


function layoutAnalysisMatchesWindow(
  analysis: Pick<ClipLayoutAnalysis, "sourceStartSec" | "sourceDurationSec">,
  startSec: number,
  durationSec: number,
  epsilonSec = 0.05,
): boolean {
  return (
    Math.abs(analysis.sourceStartSec - startSec) <= epsilonSec &&
    Math.abs(analysis.sourceDurationSec - durationSec) <= epsilonSec
  );
}


function faceBandSegmentsForCompositionPlan(input: {
  samples: FaceSample[] | null;
  cutPlan: ClipCutPlan;
  clipStartSec: number;
  editedDurationSec: number;
}): ClipSplitLayoutSegment[] | null {
  if (!input.samples || input.samples.length === 0) return null;
  const points = remapFaceSamplesForCutPlan(
    input.samples,
    input.cutPlan,
    input.clipStartSec,
  )
    .flatMap((group) => smoothFacePath(group))
    .filter(
      (sample) =>
        Number.isFinite(sample.t) &&
        Number.isFinite(sample.cx) &&
        sample.t >= 0 &&
        sample.t < input.editedDurationSec - 0.001,
    )
    .sort((left, right) => left.t - right.t);
  if (points.length === 0) return null;

  const deduplicated: SmoothedSample[] = [];
  for (const point of points) {
    const previous = deduplicated.at(-1);
    if (previous && Math.abs(previous.t - point.t) <= 0.001) {
      deduplicated[deduplicated.length - 1] = point;
      continue;
    }
    deduplicated.push(point);
  }

  const bounded =
    deduplicated.length <= 64
      ? deduplicated
      : Array.from({ length: 64 }, (_, index) => {
          const time = (index / 64) * input.editedDurationSec;
          let selected = deduplicated[0]!;
          for (const candidate of deduplicated) {
            if (candidate.t > time) break;
            selected = candidate;
          }
          return { t: time, cx: selected.cx };
        });

  return bounded.map((point, index) => ({
    startSec: index === 0 ? 0 : point.t,
    endSec: bounded[index + 1]?.t ?? input.editedDurationSec,
    layout: "single" as const,
    cxNorm: point.cx,
    cyNorm: 0.5,
    zoom: 1,
  }));
}


type SplitFallbackReason =
  | "disabled"
  | "broll_conflict"
  | "detection_unavailable"
  | "insufficient_clusters"
  | "empty_plan"
  | "no_two_up_segments"
  | "tiles_not_distinct"
  | null;


function decideSplitFallback(params: {
  hasBrollPlan: boolean;
  detectionAvailable: boolean;
  plan: BuildSplitLayoutPlanResult | null;
}): SplitFallbackReason {
  if (params.hasBrollPlan) return "broll_conflict";
  if (!params.detectionAvailable) return "detection_unavailable";
  if (!params.plan || params.plan.segments.length === 0) {
    return (params.plan?.clusterCount ?? 0) < 2 ? "insufficient_clusters" : "empty_plan";
  }







  if (params.plan.segments.every((segment) => segment.layout === "single")) {
    return "no_two_up_segments";
  }
  return null;
}

