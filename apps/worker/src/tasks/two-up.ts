/**
 * Split-screen 2-up worker spike (vizard-parity.md item "2. Split-screen
 * 2-up"). Pure helpers only — no FFmpeg execution, no Prisma, no render
 * pipeline wiring. Mirrors reframe.ts's style: detector output (Python, see
 * reframe_detect.py's `--multi` mode) in, ffmpeg filtergraph strings out,
 * everything in between unit-tested in isolation.
 *
 * Pipeline this module implements:
 *   1. `clusterFaceTracks` — turn raw per-sample multi-face detections into
 *      up to 2 stable lateral (cx) clusters ("the two interview seats").
 *   2. `classifyShotSamples` — per sample, is this a two-shot (both seats
 *      visible), a single close-up (one seat), or neither (b-roll/title) —
 *      smoothed over time and collapsed into contiguous segments.
 *   3. `assignSpeakersToClusters` — correlate AssemblyAI diarization
 *      (speakerLabel + turn timing) against which cluster shows up in
 *      SINGLE-shot samples during each speaker's turns, to label "cluster 0
 *      is Speaker 2" etc.
 *   4. `buildTwoUpFilterChain` — the actual split -> 2x crop/scale -> vstack
 *      FFmpeg filtergraph for a two-shot segment.
 */
import type { ClipAspectRatio } from "@narriflow/validators";
import { clipAspectRatioOptions } from "@narriflow/validators";
import type { TranscriptUtterance } from "@narriflow/validators";
import { cropXForCenter } from "./reframe";

// ---------------------------------------------------------------------------
// Detector types (mirrors reframe_detect.py's --multi JSON output)
// ---------------------------------------------------------------------------

/** One detected face within a multi-face sample. All fields normalized 0..1
 *  and source-pixel-corrected — see reframe_detect.py's `--multi` mode. */
export interface DetectedFace {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
}

/** One detector sample in `--multi` mode: zero or more faces, sorted by cx. */
export interface MultiFaceSample {
  t: number;
  faces: DetectedFace[];
}

// ---------------------------------------------------------------------------
// 1. clusterFaceTracks
// ---------------------------------------------------------------------------

export interface FaceCluster {
  /** 0 = the cluster seeded from the smaller (left) cx group, 1 = larger (right). */
  index: number;
  meanCx: number;
  meanCy: number;
  meanW: number;
  meanH: number;
  /** Number of samples that had a face assigned to this cluster. */
  sampleCount: number;
}

/** One face's cluster assignment within a sample. Unassigned faces (beyond
 *  `maxAssignDistance` from both clusters, or the loser of a same-sample
 *  collision — see the 3-face false-positive handling below) are simply
 *  omitted rather than null-padded. */
export interface FaceClusterAssignment {
  faceIndex: number;
  clusterIndex: number;
  distance: number;
}

export interface SampleClusterAssignment {
  t: number;
  /** Total faces detected this sample (including any left unassigned). */
  faceCount: number;
  assignments: FaceClusterAssignment[];
}

export interface ClusterFaceTracksResult {
  /** Length 0 (no usable multi-face evidence), 1 (degenerate — see below), or 2. */
  clusters: FaceCluster[];
  samples: SampleClusterAssignment[];
}

export interface ClusterFaceTracksOptions {
  /** Max normalized cx/cy distance for a face to be assigned to a cluster —
   *  beyond this it's treated as noise (e.g. a false-positive detection, or
   *  a genuinely different on-screen face outside the two interview seats)
   *  rather than forced onto the nearest seat. Interviews are laterally
   *  stable, but real footage still pans/zooms between cuts (verified
   *  against jensen-0-90.mp4 — see two-up.ts's originating spike report),
   *  so this is deliberately generous. */
  maxAssignDistance?: number;
}

const DEFAULT_MAX_ASSIGN_DISTANCE = 0.22;

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Splits a sorted list of numbers into two groups at its single largest gap. */
function splitAtLargestGap(sorted: number[]): [number[], number[]] {
  let bestGapIndex = 0;
  let bestGap = -Infinity;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1]! - sorted[i]!;
    if (gap > bestGap) {
      bestGap = gap;
      bestGapIndex = i;
    }
  }
  return [sorted.slice(0, bestGapIndex + 1), sorted.slice(bestGapIndex + 1)];
}

/**
 * 1-D clustering of multi-face detector samples by horizontal position (cx)
 * into up to 2 stable "seats". Seeds cluster centers from exactly-2-face
 * samples (the cleanest two-shot evidence — deliberately excludes 1-face and
 * 3+-face samples from seeding so a single false-positive detection or a
 * solo close-up can't skew where the seats are), splits at the largest gap
 * in that seed population, then assigns EVERY face in EVERY sample (any face
 * count) to its nearest seed center within `maxAssignDistance`.
 *
 * Same-sample collisions (two-plus faces nearest the same cluster — the
 * observed 3-face false-positive case on jensen-0-90.mp4 t=36-37s is exactly
 * this) are resolved by greedy nearest-distance-first bipartite matching:
 * at most one face per cluster per sample, closest pairs win first, and any
 * face that can't be matched (either over the distance threshold, or its
 * candidate clusters are already taken by a closer face) is left unassigned
 * rather than forced in. This is what makes the false-positive third face
 * (typically a background face or a detector artifact, further from both
 * seat centers than the two real faces) fall out as noise on its own.
 */
export function clusterFaceTracks(
  samples: MultiFaceSample[],
  options: ClusterFaceTracksOptions = {},
): ClusterFaceTracksResult {
  const maxAssignDistance = options.maxAssignDistance ?? DEFAULT_MAX_ASSIGN_DISTANCE;

  const emptyAssignments = (): SampleClusterAssignment[] =>
    samples.map((s) => ({ t: s.t, faceCount: s.faces.length, assignments: [] }));

  // --- Seed cluster centers ---
  let seedCxs = samples
    .filter((s) => s.faces.length === 2)
    .flatMap((s) => s.faces.map((f) => f.cx))
    .sort((a, b) => a - b);

  // Fallback: not enough clean 2-face evidence — widen to every face from
  // every sample (any count). Still gives a usable split on footage with
  // few clean two-shots as long as SOME multi-face signal exists.
  if (seedCxs.length < 2) {
    seedCxs = samples
      .flatMap((s) => s.faces.map((f) => f.cx))
      .sort((a, b) => a - b);
  }

  if (seedCxs.length === 0) {
    return { clusters: [], samples: emptyAssignments() };
  }
  if (seedCxs.length === 1 || new Set(seedCxs).size === 1) {
    // Degenerate: only ever saw one horizontal position — a single cluster,
    // no meaningful two-shot on this footage at all.
    const only = seedCxs[0]!;
    return {
      clusters: [{ index: 0, meanCx: only, meanCy: 0.5, meanW: 0, meanH: 0, sampleCount: 0 }],
      samples: emptyAssignments(),
    };
  }

  const [leftSeed, rightSeed] = splitAtLargestGap(seedCxs);
  const centers = [mean(leftSeed), mean(rightSeed)];

  // --- Assign every face in every sample ---
  const sampleAssignments: SampleClusterAssignment[] = samples.map((sample) => {
    const candidates: Array<{ faceIndex: number; clusterIndex: number; distance: number }> = [];
    sample.faces.forEach((face, faceIndex) => {
      centers.forEach((center, clusterIndex) => {
        const distance = Math.abs(face.cx - center);
        if (distance <= maxAssignDistance) {
          candidates.push({ faceIndex, clusterIndex, distance });
        }
      });
    });
    candidates.sort((a, b) => a.distance - b.distance);

    const takenFaces = new Set<number>();
    const takenClusters = new Set<number>();
    const assignments: FaceClusterAssignment[] = [];
    for (const candidate of candidates) {
      if (takenFaces.has(candidate.faceIndex) || takenClusters.has(candidate.clusterIndex)) {
        continue;
      }
      takenFaces.add(candidate.faceIndex);
      takenClusters.add(candidate.clusterIndex);
      assignments.push(candidate);
    }
    assignments.sort((a, b) => a.clusterIndex - b.clusterIndex);
    return { t: sample.t, faceCount: sample.faces.length, assignments };
  });

  // --- Recompute cluster stats from the final assignment (not the seed) ---
  const clusters: FaceCluster[] = centers.map((_, clusterIndex) => {
    const faces: DetectedFace[] = [];
    for (let i = 0; i < samples.length; i++) {
      for (const a of sampleAssignments[i]!.assignments) {
        if (a.clusterIndex === clusterIndex) {
          faces.push(samples[i]!.faces[a.faceIndex]!);
        }
      }
    }
    if (faces.length === 0) {
      return {
        index: clusterIndex,
        meanCx: centers[clusterIndex]!,
        meanCy: 0.5,
        meanW: 0,
        meanH: 0,
        sampleCount: 0,
      };
    }
    return {
      index: clusterIndex,
      meanCx: mean(faces.map((f) => f.cx)),
      meanCy: mean(faces.map((f) => f.cy)),
      meanW: mean(faces.map((f) => f.w)),
      meanH: mean(faces.map((f) => f.h)),
      sampleCount: faces.length,
    };
  });

  return { clusters, samples: sampleAssignments };
}

// ---------------------------------------------------------------------------
// 2. classifyShotSamples
// ---------------------------------------------------------------------------

/** "two-shot" (>=2 clusters visible), "single:<clusterIndex>" (exactly one),
 *  or "none" (no clustered face this sample — b-roll, title card, or every
 *  detection this sample fell outside the assignment threshold). */
export type ShotKind = "two-shot" | `single:${number}` | "none";

export interface ShotSampleClassification {
  t: number;
  rawKind: ShotKind;
  /** After temporal majority-vote smoothing. */
  kind: ShotKind;
}

export interface ShotSegment {
  startSec: number;
  endSec: number;
  kind: ShotKind;
}

export interface ClassifyShotSamplesOptions {
  /** Odd window size (samples, centered) for majority-vote smoothing — larger
   *  suppresses more flapping but lags shot-change response more. */
  smoothingWindowSamples?: number;
  /** Segments shorter than this are merged into a neighbor rather than kept
   *  as their own (visually jarring, sub-beat) layout switch. */
  minSegmentDurationSec?: number;
}

const DEFAULT_SMOOTHING_WINDOW_SAMPLES = 5;
const DEFAULT_MIN_SEGMENT_DURATION_SEC = 1.5;

function classifyOne(assignment: SampleClusterAssignment): ShotKind {
  const distinctClusters = new Set(assignment.assignments.map((a) => a.clusterIndex));
  if (distinctClusters.size >= 2) return "two-shot";
  if (distinctClusters.size === 1) {
    const only = [...distinctClusters][0]!;
    return `single:${only}`;
  }
  return "none";
}

/** Majority vote over a centered window of raw kinds. Ties keep the current
 *  sample's own (pre-smoothing) kind, so a perfect 50/50 split doesn't
 *  silently pick a value the sample itself never had. */
function majoritySmooth(rawKinds: ShotKind[], windowSamples: number): ShotKind[] {
  const half = Math.max(0, Math.floor(windowSamples / 2));
  return rawKinds.map((current, i) => {
    const counts = new Map<ShotKind, number>();
    for (let j = Math.max(0, i - half); j <= Math.min(rawKinds.length - 1, i + half); j++) {
      const k = rawKinds[j]!;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let bestKind = current;
    let bestCount = -1;
    for (const [kind, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        bestKind = kind;
      }
    }
    // Tie: prefer keeping the sample's own raw kind over an arbitrary Map
    // iteration-order winner.
    if (counts.get(current) === bestCount) return current;
    return bestKind;
  });
}

/** Collapses a per-sample kind list into contiguous segments. Each segment's
 *  `endSec` is the next segment's `startSec` (the last segment extends to
 *  the final sample's own `t` plus the average inter-sample gap, so it
 *  covers to roughly where the next (nonexistent) sample would have been). */
function collapseToSegments(samples: Array<{ t: number; kind: ShotKind }>): ShotSegment[] {
  if (samples.length === 0) return [];
  const segments: ShotSegment[] = [];
  let start = samples[0]!.t;
  let kind = samples[0]!.kind;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.kind !== kind) {
      segments.push({ startSec: start, endSec: samples[i]!.t, kind });
      start = samples[i]!.t;
      kind = samples[i]!.kind;
    }
  }
  const avgDt =
    samples.length > 1 ? (samples[samples.length - 1]!.t - samples[0]!.t) / (samples.length - 1) : 0;
  segments.push({ startSec: start, endSec: samples[samples.length - 1]!.t + avgDt, kind });
  return segments;
}

/** Merges consecutive segments that share the same `kind` into one. Needed
 *  because merging a micro-segment into a neighbor (below) can leave that
 *  merged segment directly adjacent to another same-kind segment on its
 *  other side — e.g. two-shot | tiny single-glitch | two-shot, where the
 *  glitch merges into the second two-shot run, which is then still right
 *  next to the first two-shot run and must collapse into it too (observed
 *  on jensen-0-90.mp4 around t=42-44s: a ~1.2s single-speaker dip between
 *  two much longer two-shot runs would otherwise survive as a spurious
 *  segment boundary between two segments of the identical kind). */
function coalesceAdjacentSameKind(segments: ShotSegment[]): ShotSegment[] {
  const out: ShotSegment[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.kind === seg.kind && last.endSec === seg.startSec) {
      last.endSec = seg.endSec;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/** Repeatedly merges the shortest under-threshold segment into whichever
 *  neighbor is longer (ties -> the following neighbor), adopting that
 *  neighbor's kind, until none remain (or only one segment is left).
 *  Re-coalesces adjacent same-kind segments after every merge (see
 *  `coalesceAdjacentSameKind`) so a merge can never leave a spurious
 *  same-kind boundary behind. */
function mergeMicroSegments(segments: ShotSegment[], minDurationSec: number): ShotSegment[] {
  let out = coalesceAdjacentSameKind(segments);
  const duration = (s: ShotSegment) => s.endSec - s.startSec;

  while (out.length > 1) {
    let shortestIndex = -1;
    let shortestDuration = Infinity;
    for (let i = 0; i < out.length; i++) {
      const d = duration(out[i]!);
      if (d < minDurationSec && d < shortestDuration) {
        shortestDuration = d;
        shortestIndex = i;
      }
    }
    if (shortestIndex === -1) break;

    const hasPrev = shortestIndex > 0;
    const hasNext = shortestIndex < out.length - 1;
    let mergeWithNext: boolean;
    if (!hasPrev) mergeWithNext = true;
    else if (!hasNext) mergeWithNext = false;
    else {
      const prevDur = duration(out[shortestIndex - 1]!);
      const nextDur = duration(out[shortestIndex + 1]!);
      mergeWithNext = nextDur >= prevDur;
    }

    if (mergeWithNext) {
      const merged: ShotSegment = {
        startSec: out[shortestIndex]!.startSec,
        endSec: out[shortestIndex + 1]!.endSec,
        kind: out[shortestIndex + 1]!.kind,
      };
      out.splice(shortestIndex, 2, merged);
    } else {
      const merged: ShotSegment = {
        startSec: out[shortestIndex - 1]!.startSec,
        endSec: out[shortestIndex]!.endSec,
        kind: out[shortestIndex - 1]!.kind,
      };
      out.splice(shortestIndex - 1, 2, merged);
    }
    out = coalesceAdjacentSameKind(out);
  }
  return out;
}

export interface ClassifyShotSamplesResult {
  perSample: ShotSampleClassification[];
  segments: ShotSegment[];
}

/**
 * Per-sample two-shot / single-close-up / none classification (from a
 * `clusterFaceTracks` result), temporally smoothed so shot noise doesn't
 * strobe the rendered layout, then collapsed into contiguous segments with
 * a minimum duration (micro-segments merge into a neighbor).
 */
export function classifyShotSamples(
  clustering: ClusterFaceTracksResult,
  options: ClassifyShotSamplesOptions = {},
): ClassifyShotSamplesResult {
  const smoothingWindowSamples = options.smoothingWindowSamples ?? DEFAULT_SMOOTHING_WINDOW_SAMPLES;
  const minSegmentDurationSec = options.minSegmentDurationSec ?? DEFAULT_MIN_SEGMENT_DURATION_SEC;

  const rawKinds = clustering.samples.map(classifyOne);
  const smoothedKinds = majoritySmooth(rawKinds, smoothingWindowSamples);

  const perSample: ShotSampleClassification[] = clustering.samples.map((s, i) => ({
    t: s.t,
    rawKind: rawKinds[i]!,
    kind: smoothedKinds[i]!,
  }));

  const rawSegments = collapseToSegments(perSample.map((s) => ({ t: s.t, kind: s.kind })));
  const segments = mergeMicroSegments(rawSegments, minSegmentDurationSec);

  return { perSample, segments };
}

// ---------------------------------------------------------------------------
// 3. assignSpeakersToClusters
// ---------------------------------------------------------------------------

export interface SpeakerClusterAssignment {
  speakerLabel: string;
  /** null when there was no single-shot evidence during this speaker's turns. */
  clusterIndex: number | null;
  /** Fraction (0..1) of the evidence samples that agreed with the winning
   *  cluster — 0 when there's no evidence at all. */
  confidence: number;
  /** Count of single-shot samples during this speaker's turns that
   *  contributed evidence (the denominator behind `confidence`). */
  evidenceSampleCount: number;
}

/**
 * Diarization-assisted speaker -> cluster assignment. Signal used: for each
 * AssemblyAI utterance (a speaker's talking turn), count how often each
 * cluster is the ONE visible face in SINGLE-shot samples (`single:<idx>`)
 * whose timestamp falls inside that turn — i.e. "when this speaker is
 * talking, whose close-up is on screen?" — then aggregate those counts
 * across all of a speaker's turns and pick the majority cluster.
 *
 * This is deliberately the only signal used (no cx-motion correlation): on
 * jensen-0-90.mp4 the single-shot-during-turn signal was unambiguous for the
 * dominant speaker (see this module's originating spike report for the
 * measured confidence), and cx-motion correlation would require a much
 * larger footage sample and a lip-sync/mouth-motion classifier to add
 * anything beyond what "whose face is alone on screen while they're
 * credited as speaking" already gives for free. Two-shot samples contribute
 * no evidence either way (both clusters visible, so they can't disambiguate
 * which of the two is the credited speaker).
 */
export function assignSpeakersToClusters(
  utterances: TranscriptUtterance[],
  shotSamples: ClassifyShotSamplesResult,
): SpeakerClusterAssignment[] {
  const singleShotSamples = shotSamples.perSample.filter((s) => s.kind.startsWith("single:"));

  const evidenceBySpeaker = new Map<string, Map<number, number>>();

  for (const utterance of utterances) {
    const speakerLabel = utterance.speakerLabel;
    let counts = evidenceBySpeaker.get(speakerLabel);
    if (!counts) {
      counts = new Map();
      evidenceBySpeaker.set(speakerLabel, counts);
    }
    for (const sample of singleShotSamples) {
      if (sample.t < utterance.startSec || sample.t > utterance.endSec) continue;
      const clusterIndex = Number(sample.kind.slice("single:".length));
      counts.set(clusterIndex, (counts.get(clusterIndex) ?? 0) + 1);
    }
  }

  const speakerLabels = [...new Set(utterances.map((u) => u.speakerLabel))];
  return speakerLabels.map((speakerLabel) => {
    const counts = evidenceBySpeaker.get(speakerLabel) ?? new Map<number, number>();
    const total = [...counts.values()].reduce((sum, c) => sum + c, 0);
    if (total === 0) {
      return { speakerLabel, clusterIndex: null, confidence: 0, evidenceSampleCount: 0 };
    }
    let bestCluster = -1;
    let bestCount = -1;
    for (const [clusterIndex, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        bestCluster = clusterIndex;
      }
    }
    return {
      speakerLabel,
      clusterIndex: bestCluster,
      confidence: bestCount / total,
      evidenceSampleCount: total,
    };
  });
}

// ---------------------------------------------------------------------------
// 4. buildTwoUpFilterChain
// ---------------------------------------------------------------------------

const aspectRatioDimensions = new Map(
  clipAspectRatioOptions.map((option) => [option.value, { width: option.width, height: option.height }]),
);

/** FFmpeg instance names for the two crop filters, targeted by sendcmd.
 *  Deliberately distinct — see buildTwoUpFilterChain's doc comment for why
 *  reusing one name (or reframe.ts's single `REFRAME_CROP_NAME`) across both
 *  tiles would be a bug, not just a style nit. */
export const TWO_UP_TOP_CROP_NAME = "crop@twoup_top";
export const TWO_UP_BOTTOM_CROP_NAME = "crop@twoup_bottom";

export interface TwoUpRegionSpec {
  /** Static normalized horizontal crop center (used unless `reframe` is set). */
  cx: number;
  /** Static normalized vertical crop center. Omit to center vertically —
   *  correct whenever the tile crop doesn't reduce source height (the
   *  common case: a landscape/near-square source cropped narrower for a
   *  portrait tile keeps full source height). */
  cy?: number;
  /** Sendcmd-driven horizontal crop track (reframe.ts style) — when set,
   *  overrides `cx` for x and ignores `cy` (vertical stays centered; the
   *  spike doesn't need vertical tracking). `cropName` MUST be unique per
   *  region within a single ffmpeg invocation (see TWO_UP_TOP_CROP_NAME /
   *  TWO_UP_BOTTOM_CROP_NAME) — see the collision gotcha below. */
  reframe?: { scriptPath: string; cropName: string } | null;
}

export interface BuildTwoUpFilterChainParams {
  aspectRatio: ClipAspectRatio;
  /** Source video dimensions (post any upstream probe/scale — same contract
   *  as buildCropAndScaleFilter's `probe.width`/`probe.height`). */
  probe: { width: number; height: number };
  top: TwoUpRegionSpec;
  bottom: TwoUpRegionSpec;
  videoInputLabel?: string;
  outputLabel?: string;
  /** Suffix appended to internal split/crop-output labels so multiple calls
   *  can coexist in one bigger filter_complex without label collisions
   *  (mirrors buildLogoFilter's `scratchSuffix`). Leave empty for a single
   *  standalone two-up render (this spike's usage). */
  labelSuffix?: string;
  /** Appended after vstack, before the output label — same contract as
   *  buildFitAndBackgroundFilter's `trailingChain` (captions/text overlay). */
  trailingChain?: string;
}

function computeTileCrop(
  srcWidth: number,
  srcHeight: number,
  tileRatio: number,
): { cropW: number; cropH: number } {
  const srcRatio = srcWidth / srcHeight;
  if (srcRatio >= tileRatio) {
    return { cropW: Math.round(srcHeight * tileRatio), cropH: srcHeight };
  }
  return { cropW: srcWidth, cropH: Math.round(srcWidth / tileRatio) };
}

function buildRegionFilter(
  region: TwoUpRegionSpec,
  srcWidth: number,
  srcHeight: number,
  cropW: number,
  cropH: number,
  tileWidth: number,
  tileHeight: number,
  inputLabel: string,
  outputLabel: string,
): string {
  const y = cropH >= srcHeight ? 0 : cropXForCenter(region.cy ?? 0.5, srcHeight, cropH);

  if (region.reframe) {
    const escaped = region.reframe.scriptPath.replace(/'/g, "'\\''");
    const x = Math.round((srcWidth - cropW) / 2); // sendcmd drives x at runtime; this is just the initial value
    return (
      `${inputLabel}sendcmd=f='${escaped}',` +
      `${region.reframe.cropName}=w=${cropW}:h=${cropH}:x=${x}:y=${y},` +
      `scale=${tileWidth}:${tileHeight}${outputLabel}`
    );
  }

  const x = cropXForCenter(region.cx, srcWidth, cropW);
  return `${inputLabel}crop=${cropW}:${cropH}:${x}:${y},scale=${tileWidth}:${tileHeight}${outputLabel}`;
}

/**
 * Builds the split -> 2x crop/scale -> vstack FFmpeg filtergraph for a
 * two-shot segment: one source split into two branches, each cropped to a
 * `W x H/2` tile (of the target aspect ratio) centered on a cluster's crop
 * region, scaled to that tile size, then stacked top-over-bottom into the
 * full `W x H` output — the same `[outv]`/`[outvbase]`-style single output
 * label contract `buildFitAndBackgroundFilter`/`buildCropAndScaleFilter`
 * satisfy (a caller threading a logo overlay on top can target `[outvbase]`
 * exactly like it does for the other two builders).
 *
 * GOTCHA (found building this): a `sendcmd` filter dispatches its commands
 * to filters BY NAME across the whole filter_complex graph, not just its own
 * branch. If both tiles' crop filters were given the same instance name
 * (e.g. reusing reframe.ts's single `REFRAME_CROP_NAME` for both), a command
 * meant for the top tile's crop would ALSO move the bottom tile's crop (and
 * vice versa) — both tiles would track whichever cluster's script fired
 * last, silently breaking independent per-seat framing. Each region's crop
 * filter name must be distinct (see `TWO_UP_TOP_CROP_NAME`/
 * `TWO_UP_BOTTOM_CROP_NAME`), and this is enforced by construction here
 * (never hardcodes one shared name) but is the caller's responsibility to
 * preserve if they roll their own `TwoUpRegionSpec.reframe.cropName`s.
 */
export function buildTwoUpFilterChain(params: BuildTwoUpFilterChainParams): string[] {
  const dims = aspectRatioDimensions.get(params.aspectRatio);
  if (!dims) {
    throw new Error(`buildTwoUpFilterChain: unsupported aspect ratio ${params.aspectRatio}`);
  }
  const { width: W, height: H } = dims;
  const tileWidth = W;
  const tileHeight = Math.round(H / 2);
  const tileRatio = tileWidth / tileHeight;

  const { cropW, cropH } = computeTileCrop(params.probe.width, params.probe.height, tileRatio);

  const videoInputLabel = params.videoInputLabel ?? "[0:v]";
  const outputLabel = params.outputLabel ?? "[outv]";
  const suffix = params.labelSuffix ?? "";
  const topSrcLabel = `[twoup_top_src${suffix}]`;
  const botSrcLabel = `[twoup_bot_src${suffix}]`;
  const topOutLabel = `[twoup_top${suffix}]`;
  const botOutLabel = `[twoup_bot${suffix}]`;
  const trailing = params.trailingChain ? `,${params.trailingChain}` : "";

  return [
    `${videoInputLabel}split=2${topSrcLabel}${botSrcLabel}`,
    buildRegionFilter(
      params.top,
      params.probe.width,
      params.probe.height,
      cropW,
      cropH,
      tileWidth,
      tileHeight,
      topSrcLabel,
      topOutLabel,
    ),
    buildRegionFilter(
      params.bottom,
      params.probe.width,
      params.probe.height,
      cropW,
      cropH,
      tileWidth,
      tileHeight,
      botSrcLabel,
      botOutLabel,
    ),
    `${topOutLabel}${botOutLabel}vstack=inputs=2,format=yuv420p${trailing}${outputLabel}`,
  ];
}
