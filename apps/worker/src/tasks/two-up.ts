/**
 * Split-screen 2-up rendering (vizard-parity.md item "2. Split-screen
 * 2-up"). Pure helpers only — no FFmpeg execution, no Prisma, no render
 * pipeline wiring (that lives in render-clips.ts, split packet B). Mirrors
 * reframe.ts's style: detector output (Python, see reframe_detect.py's
 * `--multi` mode) in, ffmpeg filtergraph strings out, everything in between
 * unit-tested in isolation.
 *
 * Pipeline this module implements:
 *   0. `remapMultiFaceSamplesForCutPlan` — multi-face sibling of reframe.ts's
 *      `remapFaceSamplesForCutPlan`: detector samples (elapsed-uncut-source
 *      seconds) -> one flat, time-sorted list on the edited (post-cut-concat)
 *      timeline.
 *   1. `clusterFaceTracks` — turn raw per-sample multi-face detections into
 *      up to 2 stable lateral (cx) clusters ("the two interview seats").
 *   2. `classifyShotSamples` — per sample, is this a two-shot (both seats
 *      visible), a single close-up (one seat), or neither (b-roll/title) —
 *      smoothed over time and collapsed into contiguous segments.
 *   3. `assignSpeakersToClusters` — correlate AssemblyAI diarization
 *      (speakerLabel + turn timing) against which cluster shows up in
 *      SINGLE-shot samples during each speaker's turns, to label "cluster 0
 *      is Speaker 2" etc. NOT wired into the render path (see its own doc
 *      comment) — kept exported for future active-speaker work.
 *   4. `computeTileCrop` / `splitTilesAreDistinct` — shared geometry facts
 *      consumed by the composition planner.
 *   5. `buildSplitLayoutPlan` — the full per-clip evidence plan: shot segments ->
 *      per-segment crop spec (two-up centers, or a single static crop),
 *      capped to a sane segment count.
 */
import type { ClipAspectRatio } from "@narriflow/validators";
import { clipAspectRatioOptions, sourceToEdited } from "@narriflow/validators";
import type { TranscriptUtterance } from "@narriflow/validators";
import type { ClipCutPlan } from "./cut-plan";
import type { FaceSample } from "./reframe";

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
  /** Mouth-region motion vs the previous sample (active-speaker signal) —
   *  see reframe_detect.py's "m"/"fm" doc. Absent/null on the first sample
   *  and on detector versions that predate the signal. */
  m?: number | null;
  /** Upper-face-region motion vs the previous sample — the head-motion
   *  normalizer for `m` (consumers use m/(fm+eps)). */
  fm?: number | null;
}

/** One detector sample in `--multi` mode: zero or more faces, sorted by cx. */
export interface MultiFaceSample {
  t: number;
  faces: DetectedFace[];
}

// ---------------------------------------------------------------------------
// 0. remapMultiFaceSamplesForCutPlan
// ---------------------------------------------------------------------------

/**
 * Multi-face sibling of reframe.ts's `remapFaceSamplesForCutPlan`: drops
 * detector samples that fall inside a deleted range and remaps the retained
 * ones' `t` from elapsed-uncut-source seconds (what `reframe_detect.py`
 * emits) onto the edited (post-cut-concat) timeline the split filtergraph's
 * per-segment `trim=start:end` windows run against — same source<->edited
 * contract every other cut-concat consumer (captions, B-roll cues, the
 * single-face auto-reframe path) uses.
 *
 * Unlike `remapFaceSamplesForCutPlan`, this returns ONE flat, time-sorted
 * list rather than one group per kept segment. `remapFaceSamplesForCutPlan`
 * splits into groups because `smoothFacePath`'s EMA carries state
 * sample-to-sample and would wrongly drift across a cut-induced gap;
 * `clusterFaceTracks` has no such per-sample carry state (clustering
 * considers each sample independently), so a flat list works fine there.
 * `classifyShotSamples`' `majoritySmooth`, however, DOES blend across a cut
 * boundary: its centered window (default 5 samples at ~4fps, ~1.25s) mixes
 * samples from both sides of a boundary that lands mid-window, so a shot
 * change at the exact cut point can lag by up to roughly half the window
 * (~0.5s) before the smoothed classification catches up. In practice this is
 * swallowed by `mergeMicroSegments`'/`capSegmentCount`'s ~1.5s minimum
 * segment duration — a boundary blend that short rarely survives as its own
 * segment — but it is real smoothing-across-a-cut, not "nothing to reset."
 * A flat list in edited-time order is still what `classifyShotSamples`'
 * segment collapse expects, and lets a two-shot/single run that happens to
 * span a (short, sub-threshold) cut boundary classify and merge normally
 * instead of being artificially split.
 */
export function remapMultiFaceSamplesForCutPlan(
  samples: MultiFaceSample[],
  cutPlan: ClipCutPlan,
  clipStartSec: number,
): MultiFaceSample[] {
  if (cutPlan.isUncut) return samples;

  const out: MultiFaceSample[] = [];
  for (const sample of samples) {
    const sourceSec = clipStartSec + sample.t;
    const segment = cutPlan.segments.find(
      (s) => sourceSec >= s.sourceStartSec && sourceSec <= s.sourceEndSec,
    );
    if (!segment) continue; // inside a cut (or outside the window)
    out.push({ t: sourceToEdited(cutPlan.map, sourceSec), faces: sample.faces });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * M2 (adversarial review): derives single-face `FaceSample[]` (the shape
 * `reframe.ts`'s `smoothFacePath`/`buildReframeSendcmdScript` consume) FROM
 * an already-completed multi-face detection pass, instead of re-running the
 * YuNet python detector a second time over the same footage. Used when a
 * split-mode clip's real 2-up plan doesn't pan out (fell back per-clip via
 * `decideSplitFallback`, or per-output via `splitTilesAreDistinct`) but
 * multi-face detection DID already run and succeed — re-detecting from
 * scratch would mean a second segment extraction AND a second full YuNet
 * pass over footage already scanned once.
 *
 * Picks the LARGEST face per sample (by normalized area `w * h`) as the
 * single "dominant" face — a reasonable proxy for "the person the shot is
 * framed on" absent any other signal, and consistent with `detectFacePath`'s
 * own single-face detector script picking its best/most-confident face.
 * Samples with zero faces map to `cx: null` (`smoothFacePath` already
 * handles gap-filling for those, same as `detectFacePath`'s native output).
 */
export function deriveSingleFaceSamplesFromMulti(
  samples: MultiFaceSample[],
): FaceSample[] {
  return samples.map((sample) => {
    if (sample.faces.length === 0) return { t: sample.t, cx: null };
    let largest = sample.faces[0]!;
    for (const face of sample.faces) {
      if (face.w * face.h > largest.w * largest.h) largest = face;
    }
    return { t: sample.t, cx: largest.cx };
  });
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
// 4. Shared tile geometry
// ---------------------------------------------------------------------------

const aspectRatioDimensions = new Map(
  clipAspectRatioOptions.map((option) => [option.value, { width: option.width, height: option.height }]),
);

export interface NormalizedLayerFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDeg?: number;
}

/**
 * Tile-aspect crop rectangle for a `W x H/2` stacked tile (top/bottom split
 * tile, or — screen packet B — the screen-layout bottom speaker tile, which
 * is geometrically the SAME tile shape: half the target output's height,
 * full its width). Exported so `screen-layout.ts` can reuse this exact math
 * instead of re-deriving it (both callers want "the biggest tile-aspect
 * rectangle this source can offer, centered").
 */
export function computeTileCrop(
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

/**
 * H1 (adversarial review, split packet B): whether a two-up split for this
 * OUTPUT aspect ratio can produce laterally distinct top/bottom crops at
 * all, given the source dimensions. `cropXForCenter` (reframe.ts) clamps its
 * `x` to `[0, srcWidth - cropWidth]` — when the tile crop's width equals (or
 * somehow exceeds) the source width, that range collapses to exactly `[0,
 * 0]`, so EVERY region's x is forced to 0 regardless of its `cx`: both tiles
 * crop the identical source region and render as visually duplicate tiles
 * (squashed identically, since the crop is also identical). This happens for
 * squarer/wider targets (1:1, 16:9) and/or portrait sources, where the tile
 * ratio (`W / (H/2)`, DOUBLE the output's own aspect since the tile is only
 * half height) demands a crop at least as wide as the source has.
 *
 * Callers (render-clips.ts) evaluate this PER OUTPUT aspect ratio, not once
 * per clip — a wide source can support 9:16 tiles (a full split render)
 * while its 1:1/16:9 outputs of the SAME clip fall back to single-speaker
 * framing instead (see the `tiles_not_distinct` fallback reason).
 */
export function splitTilesAreDistinct(
  aspectRatio: ClipAspectRatio,
  probe: { width: number; height: number },
): boolean {
  const dims = aspectRatioDimensions.get(aspectRatio);
  if (!dims) return false;
  const tileWidth = dims.width;
  const tileHeight = Math.round(dims.height / 2);
  const tileRatio = tileWidth / tileHeight;
  const { cropW } = computeTileCrop(probe.width, probe.height, tileRatio);
  return cropW < probe.width;
}


// ---------------------------------------------------------------------------
// 5. buildSplitLayoutPlan
// ---------------------------------------------------------------------------

/**
 * One segment of the per-clip split render plan, on the EDITED (post-cut)
 * timeline. "two-up" segments carry independent top/bottom crop centers;
 * "single" segments (a genuine solo close-up, OR a "none"/b-roll-ish segment
 * with no usable face evidence, which collapses to a plain 0.5 center crop —
 * see `buildSegmentCropSpec`) carry one.
 */
export type SplitLayoutSegment =
  | {
      startSec: number;
      endSec: number;
      layout: "two-up";
      topCxNorm: number;
      bottomCxNorm: number;
      /** Optional vertical crop centers + per-tile zoom (layout-engine.ts's
       *  face framing). Absent -> vertically centered, zoom 1 — the exact
       *  behavior split mode shipped with, so existing plans/tests are
       *  untouched. */
      topCyNorm?: number;
      bottomCyNorm?: number;
      topZoom?: number;
      bottomZoom?: number;
      /** Present only for a manual Studio composition override. */
      topFrame?: NormalizedLayerFrame;
      bottomFrame?: NormalizedLayerFrame;
    }
  | {
      startSec: number;
      endSec: number;
      layout: "single";
      cxNorm: number;
      /** Optional vertical crop center + zoom (layout-engine.ts). Absent ->
       *  vertically centered, zoom 1 (pre-engine behavior). */
      cyNorm?: number;
      zoom?: number;
      /** Present only for a manual Studio composition override. */
      frame?: NormalizedLayerFrame;
    };

export interface BuildSplitLayoutPlanOptions {
  /** Caps the total segment count (default 24) by repeatedly merging the
   *  globally shortest segment into its longer neighbor — an unbounded
   *  segment count would blow up the filtergraph (each segment costs a
   *  `trim` + its own crop/scale chain) for footage with lots of rapid shot
   *  changes. */
  maxSegments?: number;
  clusterOptions?: ClusterFaceTracksOptions;
  classifyOptions?: ClassifyShotSamplesOptions;
}

export interface BuildSplitLayoutPlanResult {
  /** Empty when there isn't enough multi-face evidence for a real 2-up
   *  (fewer than 2 clusters) or the clip has no in-range multi-face samples
   *  at all — callers must fall back to single-speaker framing in either
   *  case (see render-clips.ts's `decideSplitFallback`). */
  segments: SplitLayoutSegment[];
  /** 0, 1, or 2 — see `ClusterFaceTracksResult.clusters`. */
  clusterCount: number;
  /** Non-null (the PRE-cap segment count) only when capping actually merged
   *  segments down to `maxSegments` — callers log this, not the plan builder
   *  itself (this module stays pure/IO-free). */
  cappedFromSegmentCount: number | null;
}

const DEFAULT_MAX_SPLIT_SEGMENTS = 24;

/** Mean `cx` of whichever cluster's faces fall within `[startSec, endSec)`
 *  of the edited timeline — per-segment, NOT the clip-global cluster mean
 *  (spike finding: cluster means are not laterally stable across shots, so a
 *  global mean would put the crop in the wrong place on footage where the
 *  camera pans/reframes between cuts). Returns null when this cluster has no
 *  evidence in this exact window (can happen after `capSegmentCount` widens
 *  a segment's boundaries past its original shot) so the caller can fall
 *  back to the clip-global cluster mean, then to a plain center crop. */
function meanCxForClusterInWindow(
  clusterIndex: number,
  startSec: number,
  endSec: number,
  samples: MultiFaceSample[],
  clustering: ClusterFaceTracksResult,
): number | null {
  const cxs: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i]!.t;
    if (t < startSec || t >= endSec) continue;
    for (const a of clustering.samples[i]!.assignments) {
      if (a.clusterIndex === clusterIndex) {
        cxs.push(samples[i]!.faces[a.faceIndex]!.cx);
      }
    }
  }
  return cxs.length > 0 ? mean(cxs) : null;
}

/** Turns one classified shot segment into its render-time crop spec.
 *  Finding-2 policy: within a two-shot segment, whichever cluster's
 *  PER-SEGMENT mean cx is smaller (the left seat) always renders in the TOP
 *  tile — deliberately not driven by `assignSpeakersToClusters` (naive
 *  diarization-majority speaker assignment was found to fail on real
 *  footage from shot-selection bias; see that function's own doc comment).
 *  Active-speaker-aware tile assignment is future work. */
function buildSegmentCropSpec(
  segment: ShotSegment,
  samples: MultiFaceSample[],
  clustering: ClusterFaceTracksResult,
): SplitLayoutSegment {
  const { startSec, endSec, kind } = segment;

  if (kind === "two-shot") {
    const cx0 =
      meanCxForClusterInWindow(0, startSec, endSec, samples, clustering) ??
      clustering.clusters[0]?.meanCx ??
      0.5;
    const cx1 =
      meanCxForClusterInWindow(1, startSec, endSec, samples, clustering) ??
      clustering.clusters[1]?.meanCx ??
      0.5;
    return {
      startSec,
      endSec,
      layout: "two-up",
      topCxNorm: Math.min(cx0, cx1),
      bottomCxNorm: Math.max(cx0, cx1),
    };
  }

  if (kind.startsWith("single:")) {
    const clusterIndex = Number(kind.slice("single:".length));
    const cxNorm =
      meanCxForClusterInWindow(clusterIndex, startSec, endSec, samples, clustering) ??
      clustering.clusters[clusterIndex]?.meanCx ??
      0.5;
    return { startSec, endSec, layout: "single", cxNorm };
  }

  // "none": no usable face evidence this segment (b-roll/title/off-camera) —
  // a plain center crop, not a guess at either seat.
  return { startSec, endSec, layout: "single", cxNorm: 0.5 };
}

/** One merge step shared by `capSegmentCount`: folds the segment at `index`
 *  into whichever neighbor is longer (ties -> the following neighbor, same
 *  policy as `mergeMicroSegments`), adopting that neighbor's `kind`. */
function mergeSegmentIntoLongerNeighbor(segments: ShotSegment[], index: number): ShotSegment[] {
  const hasPrev = index > 0;
  const hasNext = index < segments.length - 1;
  const duration = (s: ShotSegment) => s.endSec - s.startSec;

  let mergeWithNext: boolean;
  if (!hasPrev) mergeWithNext = true;
  else if (!hasNext) mergeWithNext = false;
  else mergeWithNext = duration(segments[index + 1]!) >= duration(segments[index - 1]!);

  const out = [...segments];
  if (mergeWithNext) {
    out.splice(index, 2, {
      startSec: segments[index]!.startSec,
      endSec: segments[index + 1]!.endSec,
      kind: segments[index + 1]!.kind,
    });
  } else {
    out.splice(index - 1, 2, {
      startSec: segments[index - 1]!.startSec,
      endSec: segments[index]!.endSec,
      kind: segments[index - 1]!.kind,
    });
  }
  return coalesceAdjacentSameKind(out);
}

/** Repeatedly merges the globally shortest segment (regardless of any
 *  duration threshold — unlike `mergeMicroSegments`, which only merges
 *  segments under `minSegmentDurationSec`) until the count is at or below
 *  `maxSegments`. Returns the original segments unchanged (same array
 *  identity avoided, but same content) when already within budget. */
function capSegmentCount(
  segments: ShotSegment[],
  maxSegments: number,
): ShotSegment[] {
  let out = segments.map((s) => ({ ...s }));
  while (out.length > maxSegments && out.length > 1) {
    let shortestIndex = 0;
    let shortestDuration = Infinity;
    for (let i = 0; i < out.length; i++) {
      const d = out[i]!.endSec - out[i]!.startSec;
      if (d < shortestDuration) {
        shortestDuration = d;
        shortestIndex = i;
      }
    }
    out = mergeSegmentIntoLongerNeighbor(out, shortestIndex);
  }
  return out;
}

/**
 * Full split-render plan builder: multi-face detector samples (already
 * remapped onto the edited timeline via `remapMultiFaceSamplesForCutPlan`)
 * -> clusters -> shot segments -> per-segment crop spec, capped to a sane
 * segment count and clamped/snapped to the clip's edited duration.
 *
 * An empty `segments` result (see `BuildSplitLayoutPlanResult`'s doc comment)
 * means "no usable 2-up here" — callers (render-clips.ts) fall back to
 * single-speaker framing rather than ever rendering a 0-segment concat.
 */
export function buildSplitLayoutPlan(
  samples: MultiFaceSample[],
  clipDurationSec: number,
  options: BuildSplitLayoutPlanOptions = {},
): BuildSplitLayoutPlanResult {
  const maxSegments = options.maxSegments ?? DEFAULT_MAX_SPLIT_SEGMENTS;
  const clustering = clusterFaceTracks(samples, options.clusterOptions);

  if (clustering.clusters.length < 2 || clipDurationSec <= 0) {
    return { segments: [], clusterCount: clustering.clusters.length, cappedFromSegmentCount: null };
  }

  const classified = classifyShotSamples(clustering, options.classifyOptions);

  // Clamp/snap every segment boundary into [0, clipDurationSec] — the
  // detector's last sample (and therefore `collapseToSegments`' final
  // `endSec`) can land slightly past (or short of) the actual clip duration.
  const clamped = classified.segments
    .map((seg) => ({
      ...seg,
      startSec: Math.max(0, Math.min(seg.startSec, clipDurationSec)),
      endSec: Math.max(0, Math.min(seg.endSec, clipDurationSec)),
    }))
    .filter((seg) => seg.endSec > seg.startSec);

  if (clamped.length === 0) {
    return { segments: [], clusterCount: clustering.clusters.length, cappedFromSegmentCount: null };
  }
  clamped[0]!.startSec = 0;
  clamped[clamped.length - 1]!.endSec = clipDurationSec;

  const preCapCount = clamped.length;
  const finalShotSegments =
    preCapCount > maxSegments ? capSegmentCount(clamped, maxSegments) : clamped;

  const segments = finalShotSegments.map((seg) => buildSegmentCropSpec(seg, samples, clustering));

  return {
    segments,
    clusterCount: clustering.clusters.length,
    cappedFromSegmentCount: finalShotSegments.length < preCapCount ? preCapCount : null,
  };
}

// ---------------------------------------------------------------------------
