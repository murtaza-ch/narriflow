/**
 * Speaker-aware auto-layout engine (Vizard-parity framing overhaul).
 *
 * Pure helpers only — no FFmpeg execution, no Prisma, no render wiring (that
 * lives in layout-evidence-runtime.ts, alongside the other layout detectors).
 * Turns three per-clip signals into one segment-based layout plan the
 * shared Clip Composition Plan can render:
 *
 *   - multi-face detector samples (reframe_detect.py --multi, remapped onto
 *     the edited timeline by the caller via `remapMultiFaceSamplesForCutPlan`)
 *   - scene cuts (ffmpeg scene-change detection on the same low-res segment,
 *     remapped the same way)
 *   - diarized speech words (AssemblyAI utterances -> `speechWordsFromUtterances`,
 *     which owns the source-absolute -> edited-clip-relative conversion that
 *     `assignSpeakersToClusters` famously got wrong)
 *
 * Model (why shots, not global clusters): the two-up spike proved cluster
 * means are NOT laterally stable across shots — a multicam source cuts
 * between a wide frame and per-speaker close-ups, and a face's cx in one
 * shot says nothing about its cx in the next. So this engine never clusters
 * globally. It segments the clip into SHOTS at scene cuts first, then
 * classifies and frames each shot independently:
 *
 *   - solo shot (one stable face)  -> full-frame single crop, face-centered
 *     horizontally AND vertically, zoomed toward a target face size
 *     (Vizard-style tight framing instead of a full-height slice).
 *   - multi-face shot (a wide/two-shot) -> stacked two-up of the two most
 *     prominent seats when the output can seat two distinct tiles, else a
 *     single crop centered to cover the seats.
 *   - no-face shot (b-roll, slides, title cards) -> full-source fit.
 *
 * Diarization refines, never decides alone. Voice-to-face association is
 * retained as a confidence-scored diagnostic and an opt-in editorial style;
 * the production default follows observed Vizard behavior and holds a
 * stable two-person camera shot as two-up across speaking turns. A long shot
 * can demote to one crop only when its composition is already strongly
 * weighted toward one visibly larger face. Backchannels ("mm-hmm") are
 * suppressed by a minimum-turn floor so they can never flip the layout.
 *
 * A trustworthy single-camera talking head still returns a persisted,
 * face-centered segment. A completed no-face shot returns an explicit full
 * source fit segment. `segments: []` is reserved for incomplete detection.
 */
import type {
  ClipAutoLayoutSegment,
  ClipAutoLayoutSubject,
  TranscriptUtterance,
} from "@narriflow/validators";
import { sourceToEdited } from "@narriflow/validators";
import type { ClipCutPlan } from "./cut-plan";
import type { DetectedFace, MultiFaceSample } from "./two-up";

// ---------------------------------------------------------------------------
// Speech timebase conversion + turns
// ---------------------------------------------------------------------------

/** One diarized word on the EDITED clip-relative timeline. */
export interface SpeechWord {
  startSec: number;
  endSec: number;
  speaker: string;
}

/** One merged speaking turn on the edited clip-relative timeline. */
export interface SpeakerTurn {
  speaker: string;
  startSec: number;
  endSec: number;
}

/**
 * Flattens utterances' words into edited-clip-relative `SpeechWord`s.
 * Utterance/word times are SOURCE-ABSOLUTE seconds (the same coordinates
 * `generateAssFromSlice` subtracts `clipStartSec` from); detector samples
 * and layout segments run on the edited (post-cut-concat) clip-relative
 * timeline. This is the single conversion point — the timebase mismatch
 * that made `assignSpeakersToClusters` unusable can't recur as long as
 * every speech consumer in this module goes through here.
 *
 * Words falling inside a deleted range (or outside the clip window) are
 * dropped, mirroring `remapMultiFaceSamplesForCutPlan`'s policy for faces.
 * Utterances with no word timings contribute the utterance span itself as
 * one pseudo-word so diarization-only transcripts still produce turns.
 */
export function speechWordsFromUtterances(
  utterances: TranscriptUtterance[],
  cutPlan: ClipCutPlan,
  clipStartSec: number,
  clipEndSec: number,
): SpeechWord[] {
  const out: SpeechWord[] = [];

  const push = (startSec: number, endSec: number, speaker: string) => {
    const s = Math.max(startSec, clipStartSec);
    const e = Math.min(endSec, clipEndSec);
    if (e <= s) return;
    if (cutPlan.isUncut) {
      out.push({
        startSec: s - clipStartSec,
        endSec: e - clipStartSec,
        speaker,
      });
      return;
    }
    // Cut plan active: keep only the portion inside kept segments, remapped.
    for (const segment of cutPlan.segments) {
      const ss = Math.max(s, segment.sourceStartSec);
      const se = Math.min(e, segment.sourceEndSec);
      if (se <= ss) continue;
      out.push({
        startSec: sourceToEdited(cutPlan.map, ss),
        endSec: sourceToEdited(cutPlan.map, se),
        speaker,
      });
    }
  };

  for (const utterance of utterances) {
    const speaker = utterance.speakerLabel;
    if (utterance.words.length > 0) {
      for (const word of utterance.words) {
        push(word.startSec, word.endSec, speaker);
      }
    } else {
      push(utterance.startSec, utterance.endSec, speaker);
    }
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

export interface BuildSpeakerTurnsOptions {
  /** Same-speaker words further apart than this start a new turn. */
  maxGapSec?: number;
  /** Turns shorter than this (backchannels — "mm-hmm", "right") are dropped
   *  entirely rather than merged: a dropped backchannel must not extend a
   *  neighbor turn across a real boundary. */
  minTurnSec?: number;
}

const TURNS_DEFAULTS: Required<BuildSpeakerTurnsOptions> = {
  maxGapSec: 1.0,
  minTurnSec: 0.8,
};

/** Merges consecutive same-speaker words into speaking turns, dropping
 *  sub-`minTurnSec` backchannels so they can never flip a layout. After the
 *  drop, adjacent same-speaker turns re-merge across the removed gap — a
 *  "mm-hmm" interjection must not split the interrupted speaker's turn in
 *  two any more than it should count as a turn itself. */
export function buildSpeakerTurns(
  words: SpeechWord[],
  options: BuildSpeakerTurnsOptions = {},
): SpeakerTurn[] {
  const { maxGapSec, minTurnSec } = { ...TURNS_DEFAULTS, ...options };
  const merge = (input: SpeakerTurn[]): SpeakerTurn[] => {
    const out: SpeakerTurn[] = [];
    for (const turn of input) {
      const last = out[out.length - 1];
      if (
        last &&
        last.speaker === turn.speaker &&
        turn.startSec - last.endSec <= maxGapSec
      ) {
        last.endSec = Math.max(last.endSec, turn.endSec);
      } else {
        out.push({ ...turn });
      }
    }
    return out;
  };
  const raw = merge(
    words.map((w) => ({ speaker: w.speaker, startSec: w.startSec, endSec: w.endSec })),
  );
  return merge(raw.filter((t) => t.endSec - t.startSec >= minTurnSec));
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export interface Shot {
  startSec: number;
  endSec: number;
}

/** Splits `[0, durationSec]` into shots at the given scene-cut times
 *  (edited clip-relative). Source cuts are editorial facts and never merge. */
export function segmentShots(
  sceneCuts: number[],
  durationSec: number,
): Shot[] {
  if (durationSec <= 0) return [];
  const sorted = [...new Set(sceneCuts.map((timeSec) => timeSec.toFixed(3)))]
    .map(Number)
    .filter((t) => t > 0 && t < durationSec)
    .sort((a, b) => a - b);
  const boundaries = [0, ...sorted];
  return boundaries.map((start, i) => ({
    startSec: start,
    endSec: i + 1 < boundaries.length ? boundaries[i + 1]! : durationSec,
  }));
}

/**
 * Second cut source (adversarial review M5/C1): a hard camera cut between
 * two framings of the SAME set can score under ffmpeg's scene threshold —
 * especially on the crf30 360p detection proxy — but the detector sees it
 * plainly as a discontinuity in face position or face count. Emits a cut at
 * every consecutive-sample jump: single-face cx moving further than
 * `minCxJump` (a head can't teleport a quarter of the frame in one sample),
 * or the face count changing and staying changed for the next sample too
 * (the persistence check keeps a single-frame YuNet dropout from minting a
 * cut). Merged with scdet's cuts by the caller; duplicate boundaries are
 * harmless and source cuts remain intact.
 */
export function deriveFaceDiscontinuityCuts(
  samples: MultiFaceSample[],
  options: { minCxJump?: number } = {},
): number[] {
  const minCxJump = options.minCxJump ?? 0.18;
  const cuts: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const curr = samples[i]!;
    if (prev.faces.length === 1 && curr.faces.length === 1) {
      if (Math.abs(curr.faces[0]!.cx - prev.faces[0]!.cx) >= minCxJump) {
        cuts.push(curr.t);
      }
      continue;
    }
    if (prev.faces.length !== curr.faces.length) {
      const next = samples[i + 1];
      if (next && next.faces.length === curr.faces.length) {
        cuts.push(curr.t);
      }
    }
  }
  // Face discontinuities are only an auxiliary cut source. Debounce their
  // own detector jitter without ever suppressing supplied scene cuts.
  return cuts.filter(
    (cut, index) => index === 0 || cut - cuts[index - 1]! >= 0.6,
  );
}

export interface FilterAutomaticFaceSamplesOptions {
  /** YuNet scores below this do not start a new automatic framing track. */
  minStartScore?: number;
  /** A weaker detection may continue a recently high-confidence track. */
  minContinuationScore?: number;
  /** A continuation must remain close to the last accepted face center. */
  maxContinuationDistance?: number;
  /** A track expires after this detector gap. */
  maxContinuationGapSec?: number;
  /** Known source cuts reset admission tracks. */
  resetAtSecs?: readonly number[];
}

const FACE_ADMISSION_DEFAULTS: Omit<
  Required<FilterAutomaticFaceSamplesOptions>,
  "resetAtSecs"
> = {
  minStartScore: 0.85,
  minContinuationScore: 0.6,
  maxContinuationDistance: 0.12,
  maxContinuationGapSec: 0.75,
};

/**
 * Admits faces before any automatic framing decision. A strong face can open
 * a track. A weaker face only survives when it continues that recent track.
 * This rejects static false positives such as signs or posters without
 * encoding anything about their location or appearance.
 */
export function filterAutomaticFaceSamples(
  samples: readonly MultiFaceSample[],
  options: FilterAutomaticFaceSamplesOptions = {},
): MultiFaceSample[] {
  const settings = { ...FACE_ADMISSION_DEFAULTS, ...options };
  const tracks: Array<{ face: DetectedFace; t: number }> = [];
  const resets = [...(options.resetAtSecs ?? [])].sort((a, b) => a - b);
  let resetIndex = 0;
  return samples.map((sample) => {
    while (resetIndex < resets.length && sample.t >= resets[resetIndex]!) {
      tracks.length = 0;
      resetIndex += 1;
    }
    const activeTracks = tracks.filter(
      (track) => sample.t - track.t <= settings.maxContinuationGapSec,
    );
    const faces = sample.faces.filter((face) => {
      const continuation = activeTracks.some(
        (track) =>
          Math.hypot(face.cx - track.face.cx, face.cy - track.face.cy) <=
          settings.maxContinuationDistance,
      );
      return (
        face.score >= settings.minStartScore ||
        (face.score >= settings.minContinuationScore && continuation)
      );
    });
    for (const face of faces) {
      const existing = tracks.find(
        (track) =>
          sample.t - track.t <= settings.maxContinuationGapSec &&
          Math.hypot(face.cx - track.face.cx, face.cy - track.face.cy) <=
            settings.maxContinuationDistance,
      );
      if (existing) {
        existing.face = face;
        existing.t = sample.t;
      } else {
        tracks.push({ face, t: sample.t });
      }
    }
    return { t: sample.t, faces };
  });
}

// ---------------------------------------------------------------------------
// Per-shot face analysis
// ---------------------------------------------------------------------------

/** One stable face position ("seat") within a single shot. All values are
 *  medians over the shot's samples, normalized 0..1 against the source. */
export interface ShotSeat {
  cx: number;
  cy: number;
  /** Median face height (normalized to source height). */
  h: number;
  /** Fraction of the shot's samples this seat appeared in. */
  presence: number;
}

export type ShotKind = "solo" | "multi" | "none";

export interface ShotAnalysis {
  shot: Shot;
  kind: ShotKind;
  /** Sorted by descending face size. Empty iff kind === "none". */
  seats: ShotSeat[];
  /** Stable, simultaneously observed people available to explicit scene
   * layouts. Left-to-right order is deterministic within this shot. */
  subjectSeats: ShotSeat[];
  sampleCount: number;
}

export interface AnalyzeShotOptions {
  /** cx gap beyond which two faces in one shot count as separate seats. */
  seatGapNorm?: number;
  /** A seat present in fewer than this fraction of the shot's samples is
   *  discarded as a false positive / walk-through. */
  minSeatPresence?: number;
  /** Below this face-count fraction the shot is "none" even if a stray
   *  sample saw something. */
  minFaceSampleFraction?: number;
  /** Co-occurrence floor (adversarial review C1): a shot only counts as
   *  "multi" when at least this fraction of its face-bearing samples saw
   *  TWO OR MORE faces AT ONCE. Without this, a run of alternating
   *  one-face close-ups (a missed camera cut) clusters into two seats with
   *  ~0.5 presence each and renders as a two-up of two crops of the SAME
   *  frame — one tile the speaker, the other their empty chair. Mirrors
   *  the co-occurrence rule used by the explicit Split evidence analyzer
   *  (`classifyOne` in two-up.ts). */
  minCoOccurrence?: number;
}

const ANALYZE_DEFAULTS: Required<AnalyzeShotOptions> = {
  seatGapNorm: 0.12,
  minSeatPresence: 0.35,
  minFaceSampleFraction: 0.4,
  minCoOccurrence: 0.5,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Derives up to four face anchors from samples that observed those faces at
 * the same time. Choosing a supported count before clustering prevents one
 * person moving across the frame from becoming several layout subjects.
 */
function cooccurringSubjectSeats(
  samples: MultiFaceSample[],
  samplesWithFaces: number,
  minCoOccurrence: number,
): ShotSeat[] {
  let count = 1;
  for (let candidate = 2; candidate <= 4; candidate++) {
    const cooccurring = samples.filter(
      (sample) => sample.faces.length >= candidate,
    ).length;
    if (cooccurring / samplesWithFaces < minCoOccurrence) break;
    count = candidate;
  }
  if (count === 1) return [];

  const frames = samples
    .filter((sample) => sample.faces.length >= count)
    .map((sample) =>
      [...sample.faces]
        .sort((left, right) => right.w * right.h - left.w * left.h)
        .slice(0, count)
        .sort((left, right) => left.cx - right.cx),
    );
  return Array.from({ length: count }, (_, index) => {
    const faces = frames.map((frame) => frame[index]!);
    return {
      cx: median(faces.map((face) => face.cx)),
      cy: median(faces.map((face) => face.cy)),
      h: median(faces.map((face) => face.h)),
      presence: frames.length / samples.length,
    };
  });
}

/**
 * Classifies one shot from the detector samples inside its window. Seats are
 * formed by 1-D cx clustering WITHIN the shot only (per the two-up spike's
 * finding that cluster positions are only stable within a shot): faces
 * across the shot's samples are sorted by cx and split wherever the gap to
 * the previous face exceeds `seatGapNorm`, then each group must clear a
 * presence floor to survive as a seat.
 */
export function analyzeShot(
  shot: Shot,
  samples: MultiFaceSample[],
  options: AnalyzeShotOptions = {},
): ShotAnalysis {
  const { seatGapNorm, minSeatPresence, minFaceSampleFraction, minCoOccurrence } = {
    ...ANALYZE_DEFAULTS,
    ...options,
  };

  const inShot = samples.filter(
    (s) => s.t >= shot.startSec && s.t < shot.endSec,
  );
  const sampleCount = inShot.length;
  if (sampleCount === 0) {
    return { shot, kind: "none", seats: [], subjectSeats: [], sampleCount };
  }

  const allFaces: DetectedFace[] = inShot.flatMap((s) => s.faces);
  const samplesWithFaces = inShot.filter((s) => s.faces.length > 0).length;
  if (
    allFaces.length === 0 ||
    samplesWithFaces / sampleCount < minFaceSampleFraction
  ) {
    return { shot, kind: "none", seats: [], subjectSeats: [], sampleCount };
  }

  // Co-occurrence gate (C1): "multi" demands both faces on screen AT THE
  // SAME TIME in a real share of samples — computed up front so the seat
  // clustering below can't turn temporally-disjoint close-ups into seats.
  const multiFaceSampleCount = inShot.filter((s) => s.faces.length >= 2).length;
  const coOccurs = multiFaceSampleCount / samplesWithFaces >= minCoOccurrence;

  // 1-D gap clustering by cx within the shot.
  const sorted = [...allFaces].sort((a, b) => a.cx - b.cx);
  const groups: DetectedFace[][] = [[sorted[0]!]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const face = sorted[i]!;
    if (face.cx - prev.cx > seatGapNorm) {
      groups.push([face]);
    } else {
      groups[groups.length - 1]!.push(face);
    }
  }

  const seats: ShotSeat[] = groups
    .map((faces) => ({
      cx: median(faces.map((f) => f.cx)),
      cy: median(faces.map((f) => f.cy)),
      h: median(faces.map((f) => f.h)),
      presence: Math.min(1, faces.length / sampleCount),
    }))
    .filter((seat) => seat.presence >= minSeatPresence)
    .sort((a, b) => b.h - a.h);

  if (seats.length === 0) {
    return { shot, kind: "none", seats: [], subjectSeats: [], sampleCount };
  }
  if (seats.length > 1 && !coOccurs) {
    // Two-plus lateral positions but rarely on screen together: this is a
    // missed camera cut alternating between close-ups, not a two-shot.
    // Demote to solo on the most-present seat — the safe direction (a
    // slightly-off single crop beats a two-up of one person's face and
    // their empty chair).
    const dominant = [...seats].sort((a, b) => b.presence - a.presence)[0]!;
    return {
      shot,
      kind: "solo",
      seats: [dominant],
      subjectSeats: [dominant],
      sampleCount,
    };
  }
  const kind = seats.length === 1 ? "solo" : "multi";
  const cooccurringSubjects = coOccurs
    ? cooccurringSubjectSeats(inShot, samplesWithFaces, minCoOccurrence)
    : [];
  return {
    shot,
    kind,
    seats,
    subjectSeats:
      cooccurringSubjects.length > 0 ? cooccurringSubjects : [seats[0]!],
    sampleCount,
  };
}

// ---------------------------------------------------------------------------
// Speaker -> seat mapping (visual active-speaker signal x diarization)
// ---------------------------------------------------------------------------

export interface AssignSeatsOptions {
  /** Minimum ratio-of-mean-activity margin between a speaker's best and
   *  second-best seat for the assignment to count. */
  minMargin?: number;
  /** Minimum evidence samples (per speaker, on their best seat) — below
   *  this the mapping is refused rather than guessed. */
  minSamples?: number;
  /** Small constant added to the upper-face normalizer so a perfectly
   *  still head can't divide by ~zero. */
  normalizerEps?: number;
}

const ASSIGN_DEFAULTS: Required<AssignSeatsOptions> = {
  minMargin: 1.25,
  minSamples: 8,
  normalizerEps: 0.01,
};

/**
 * Maps diarized speaker labels to seats within ONE multi-face shot by
 * correlating each seat's head-motion-normalized mouth activity
 * (`m / (fm + eps)` — see reframe_detect.py) with when each speaker is
 * diarized as talking. Aggregates over ALL of a speaker's turn-active
 * samples in the shot — per-sample the visual signal is noisy (a listener's
 * nod can out-churn a talker for a second), but over a full turn the real
 * talker's seat wins by a wide margin (measured ~1.6x on real two-host
 * footage).
 *
 * Only samples where EXACTLY ONE speaker is diarized active contribute —
 * crosstalk samples can't attribute activity to a seat. Assignments are
 * greedy by margin and one-to-one; a speaker whose margin or evidence is
 * too thin simply doesn't get a seat; callers retain the shot's observed
 * topology rather than guessing a speaker crop.
 */
export function assignSeatsToSpeakers(
  seats: ShotSeat[],
  shot: Shot,
  samples: MultiFaceSample[],
  turns: SpeakerTurn[],
  options: AssignSeatsOptions = {},
): Map<string, number> {
  const { minMargin, minSamples, normalizerEps } = {
    ...ASSIGN_DEFAULTS,
    ...options,
  };
  const out = new Map<string, number>();
  if (seats.length < 2) return out;

  const activeSpeakerAt = (t: number): string | null => {
    let active: string | null = null;
    for (const turn of turns) {
      if (t >= turn.startSec && t <= turn.endSec) {
        if (active !== null && active !== turn.speaker) return null; // crosstalk
        active = turn.speaker;
      }
    }
    return active;
  };

  // evidence[speaker][seatIndex] = list of activity ratios
  const evidence = new Map<string, number[][]>();
  for (const sample of samples) {
    if (sample.t < shot.startSec || sample.t >= shot.endSec) continue;
    const speaker = activeSpeakerAt(sample.t);
    if (!speaker) continue;
    for (const face of sample.faces) {
      if (face.m == null || face.fm == null) continue;
      // Nearest seat by cx, within the same tolerance seat clustering used.
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < seats.length; i++) {
        const dist = Math.abs(face.cx - seats[i]!.cx);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      if (best === -1 || bestDist > 0.12) continue;
      let rows = evidence.get(speaker);
      if (!rows) {
        rows = seats.map(() => []);
        evidence.set(speaker, rows);
      }
      rows[best]!.push(face.m / (face.fm + normalizerEps));
    }
  }

  const candidates: Array<{ speaker: string; seat: number; margin: number; n: number }> = [];
  for (const [speaker, rows] of evidence) {
    const means = rows.map((r) =>
      r.length > 0 ? r.reduce((s, v) => s + v, 0) / r.length : 0,
    );
    const order = means
      .map((mean, seat) => ({ mean, seat }))
      .sort((a, b) => b.mean - a.mean);
    const bestRow = rows[order[0]!.seat]!;
    if (bestRow.length < minSamples) continue;
    const second = order[1]?.mean ?? 0;
    const margin = order[0]!.mean / Math.max(second, 1e-6);
    if (margin < minMargin) continue;
    candidates.push({ speaker, seat: order[0]!.seat, margin, n: bestRow.length });
  }

  candidates.sort((a, b) => b.margin - a.margin);
  const takenSeats = new Set<number>();
  for (const c of candidates) {
    if (takenSeats.has(c.seat) || out.has(c.speaker)) continue;
    takenSeats.add(c.seat);
    out.set(c.speaker, c.seat);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Face framing (vertical composition + zoom)
// ---------------------------------------------------------------------------

export interface FrameFaceOptions {
  /** Target face height as a fraction of the (zoomed) crop height. */
  targetFaceFrac?: number;
  /** Zoom ceiling — bounds upscale softness. */
  maxZoom?: number;
  /** Where the face center sits vertically within the crop (0 = top). */
  headroomFrac?: number;
}

const FRAME_DEFAULTS: Required<FrameFaceOptions> = {
  targetFaceFrac: 0.26,
  maxZoom: 1.4,
  headroomFrac: 0.42,
};

export interface FramedCrop {
  cxNorm: number;
  cyNorm: number;
  zoom: number;
}

function cropCenterY(
  faceCenterY: number,
  baseCropHFrac: number,
  zoom: number,
  options: FrameFaceOptions,
): number {
  const headroomFrac = options.headroomFrac ?? FRAME_DEFAULTS.headroomFrac;
  return Math.max(0, Math.min(1,
    faceCenterY + (0.5 - headroomFrac) * baseCropHFrac / zoom,
  ));
}

/**
 * Computes the crop framing for one seat: zoom toward a target on-screen
 * face size (never zooming out past the base crop, never past `maxZoom`),
 * with the face center placed at `headroomFrac` of the crop height so eyes
 * land near the upper third instead of dead center.
 *
 * `baseCropHFrac` is the un-zoomed crop height as a fraction of source
 * height (1.0 whenever the crop keeps full source height — the common
 * landscape-source-to-portrait-output case). The returned `cyNorm` is the
 * desired crop-center Y in source-normalized coordinates; the filter
 * builder clamps it so the window stays inside the frame.
 */
export function frameFaceInCrop(
  seat: { cx: number; cy: number; h: number },
  baseCropHFrac: number,
  options: FrameFaceOptions = {},
): FramedCrop {
  const { targetFaceFrac, maxZoom } = {
    ...FRAME_DEFAULTS,
    ...options,
  };
  if (!(seat.h > 0) || !(baseCropHFrac > 0)) {
    return { cxNorm: seat.cx, cyNorm: 0.5, zoom: 1 };
  }
  // Face height as a fraction of the base (un-zoomed) crop height.
  const faceFracInBaseCrop = seat.h / baseCropHFrac;
  const zoom = Math.min(maxZoom, Math.max(1, targetFaceFrac / faceFracInBaseCrop));
  // Desired crop-center Y: face center sits at `headroomFrac` of the crop,
  // so the center (0.5 point) is `0.5 - headroomFrac` of a crop-height
  // below the face center.
  const cyNorm = cropCenterY(seat.cy, baseCropHFrac, zoom, options);
  return { cxNorm: seat.cx, cyNorm, zoom };
}

/**
 * Builds a bounded camera path for one observed seat. The shot's median face
 * size decides zoom once. Individual samples may only move the crop center.
 * Association starts at the shot seat but then follows the last accepted
 * face, so a genuine camera pan is not dropped once it travels beyond the
 * shot median. A size check and bounded per-sample travel still make a brief
 * unrelated detection safer to ignore than to follow.
 */
function cropTrackForSeat(
  shot: Shot,
  samples: readonly MultiFaceSample[],
  seat: ShotSeat,
  baseCropHFrac: number,
  zoom: number,
  options: FrameFaceOptions = {},
): Array<{ timeSec: number; cxNorm: number; cyNorm: number }> {
  const candidates: Array<{ timeSec: number; cxNorm: number; cyNorm: number }> = [];
  let previous: { face: DetectedFace; timeSec: number } | null = null;
  for (const sample of samples) {
    if (sample.t < shot.startSec || sample.t >= shot.endSec) continue;
    const anchor: Pick<DetectedFace, "cx" | "cy" | "h"> = previous?.face ?? seat;
    const maxDistance = previous
      ? Math.min(0.32, 0.16 + (sample.t - previous.timeSec) * 0.5)
      : 0.36;
    const face: DetectedFace | undefined = [...sample.faces]
      .filter((candidate) => {
        const sizeRatio: number = candidate.h / Math.max(anchor.h, 1e-6);
        return sizeRatio >= 0.55 && sizeRatio <= 1.8;
      })
      .sort(
        (left, right) =>
          Math.hypot(left.cx - anchor.cx, left.cy - anchor.cy) -
          Math.hypot(right.cx - anchor.cx, right.cy - anchor.cy),
      )[0];
    if (!face || Math.hypot(face.cx - anchor.cx, face.cy - anchor.cy) > maxDistance) {
      continue;
    }
    previous = { face, timeSec: sample.t };
    candidates.push({
      timeSec: sample.t,
      cxNorm: face.cx,
      cyNorm: cropCenterY(face.cy, baseCropHFrac, zoom, options),
    });
  }
  if (candidates.length === 0) return [];

  const smoothed: typeof candidates = [];
  for (const candidate of candidates) {
    const previous = smoothed[smoothed.length - 1];
    if (!previous) {
      smoothed.push({ ...candidate });
      continue;
    }
    // Dead-zone avoids detector jitter. EMA gives deliberate movement when
    // the subject really moves, without inventing any new camera cuts.
    const dx = candidate.cxNorm - previous.cxNorm;
    const dy = candidate.cyNorm - previous.cyNorm;
    const distance = Math.hypot(dx, dy);
    // Smooth detector noise, but respond rapidly to a deliberate pan. At
    // this scale a fixed 0.35 EMA lags the crop outside a moving face.
    const follow = distance > 0.03 ? 0.8 : 0.35;
    smoothed.push({
      timeSec: candidate.timeSec,
      cxNorm: Math.abs(dx) < 0.014 ? previous.cxNorm : previous.cxNorm + dx * follow,
      cyNorm: Math.abs(dy) < 0.014 ? previous.cyNorm : previous.cyNorm + dy * follow,
    });
  }
  const bounded = smoothed.length <= 24
    ? smoothed
    : Array.from({ length: 24 }, (_, index) =>
      smoothed[Math.round(index * (smoothed.length - 1) / 23)]!,
    );
  const first = bounded[0]!;
  const last = bounded[bounded.length - 1]!;
  return [
    { ...first, timeSec: shot.startSec },
    ...bounded.filter((keyframe) => keyframe.timeSec > shot.startSec && keyframe.timeSec < shot.endSec),
    { ...last, timeSec: shot.endSec },
  ].filter((keyframe, index, list) => index === 0 || keyframe.timeSec > list[index - 1]!.timeSec);
}

// ---------------------------------------------------------------------------
// The plan builder
// ---------------------------------------------------------------------------

export interface BuildAutoLayoutPlanParams {
  /** Detector samples on the EDITED clip-relative timeline (caller remaps
   *  via `remapMultiFaceSamplesForCutPlan`). */
  samples: MultiFaceSample[];
  /** Scene-cut times on the edited clip-relative timeline. */
  sceneCuts: number[];
  /** Diarized words on the edited clip-relative timeline
   *  (`speechWordsFromUtterances`). */
  words: SpeechWord[];
  /** Edited clip duration. */
  durationSec: number;
  /** Whether this output's aspect ratio can seat two laterally distinct
   *  two-up tiles. False demotes every would-be
   *  split to a single crop covering the seats. */
  allowTwoUp: boolean;
  options?: BuildAutoLayoutPlanOptions;
}

export interface BuildAutoLayoutPlanOptions {
  analyzeOptions?: AnalyzeShotOptions;
  turnsOptions?: BuildSpeakerTurnsOptions;
  frameOptions?: FrameFaceOptions;
  assignOptions?: AssignSeatsOptions;
  /** Optional editorial style that cuts from a stable two-person shot to a
   * mapped active speaker. Disabled by default: observed Vizard output holds
   * a two-up for the whole camera shot, which is calmer and safer. */
  activeSpeakerCuts?: boolean;
  /** Minimum diarized-turn overlap with a multi-face shot for that turn to
   *  earn a full-frame solo cut of the speaker's seat. */
  turnSoloMinSec?: number;
  /** Silences/attribution gaps up to this long hold the current framing
   *  instead of flashing a split (Vizard holds the speaker through pauses). */
  holdGapSec?: number;
  /** Multi-face shots at or above this length with one dominant speaker
   *  render as a single crop of the dominant seat when the seat is
   *  identifiable; below it (or without dominance) they render as a split. */
  dominantShotMinSec?: number;
  /** Speech-share threshold for "one speaker dominates this shot". */
  dominantShareMin?: number;
}

const PLAN_DEFAULTS: Required<
  Pick<
    BuildAutoLayoutPlanOptions,
    | "dominantShotMinSec"
    | "dominantShareMin"
    | "turnSoloMinSec"
    | "holdGapSec"
    | "activeSpeakerCuts"
  >
> = {
  dominantShotMinSec: 5,
  dominantShareMin: 0.72,
  turnSoloMinSec: 1.6,
  holdGapSec: 1.5,
  activeSpeakerCuts: false,
};

export interface BuildAutoLayoutPlanResult {
  /** Empty only when detection ended too early. A one-shot talking head and
   * a completed no-face shot both return explicit renderable segments. */
  segments: ClipAutoLayoutSegment[];
  shotCount: number;
  soloShotCount: number;
  multiShotCount: number;
  twoUpSegmentCount: number;
  speakerCount: number;
  /** Speakers successfully mapped to seats by the visual active-speaker
   *  signal (max across shots) — 0 means every multi-face shot fell back to
   *  split/dominant heuristics. */
  mappedSpeakerCount: number;
}

/** Speech time per speaker within a window, from turns. */
function speechShareInWindow(
  turns: SpeakerTurn[],
  startSec: number,
  endSec: number,
): Map<string, number> {
  const shares = new Map<string, number>();
  for (const turn of turns) {
    const s = Math.max(turn.startSec, startSec);
    const e = Math.min(turn.endSec, endSec);
    if (e <= s) continue;
    shares.set(turn.speaker, (shares.get(turn.speaker) ?? 0) + (e - s));
  }
  return shares;
}

/**
 * The full engine: shots -> per-shot analysis -> per-shot layout decision.
 *
 * Solo shots frame the face (`frameFaceInCrop`); "none" shots use source
 * fit. Exactly two stable, co-observed subjects may use two-up. Crowded or
 * uncertain multi-face shots use source fit; an unsplit two-person shot may
 * use a dominant-seat crop only when that seat has earned it.
 */
export function buildAutoLayoutPlan(
  params: BuildAutoLayoutPlanParams,
): BuildAutoLayoutPlanResult {
  const opts = params.options ?? {};
  const {
    dominantShotMinSec,
    dominantShareMin,
    turnSoloMinSec,
    holdGapSec,
    activeSpeakerCuts,
  } = {
    ...PLAN_DEFAULTS,
    ...opts,
  };

  const empty = (shots: ShotAnalysis[]): BuildAutoLayoutPlanResult => ({
    segments: [],
    shotCount: shots.length,
    soloShotCount: shots.filter((s) => s.kind === "solo").length,
    multiShotCount: shots.filter((s) => s.kind === "multi").length,
    twoUpSegmentCount: 0,
    speakerCount: new Set(params.words.map((w) => w.speaker)).size,
    mappedSpeakerCount: 0,
  });

  if (params.durationSec <= 0 || params.samples.length === 0) {
    return empty([]);
  }
  const samples = filterAutomaticFaceSamples(params.samples, {
    resetAtSecs: params.sceneCuts,
  });

  // Truncated detection (adversarial review M2): reframe_detect.py stops at
  // the first failed frame read, so a decode error mid-clip leaves the tail
  // unsampled. A plan can only speak for footage it saw — abandon entirely
  // (EMA/static fallback) rather than center-cropping the unseen tail.
  const lastSampleT = params.samples[params.samples.length - 1]!.t;
  if (params.durationSec - lastSampleT > 3) {
    return empty([]);
  }

  // Scene cuts from ffmpeg PLUS face-discontinuity cuts (M5/C1): the
  // detector's own view of the footage catches hard cuts the low-res scdet
  // proxy misses — without them a missed cut merges two different camera
  // framings into one "shot" and everything downstream misframes.
  const allCuts = [
    ...params.sceneCuts,
    ...deriveFaceDiscontinuityCuts(samples).filter(
      (faceCut) =>
        !params.sceneCuts.some((sceneCut) => Math.abs(sceneCut - faceCut) < 0.6),
    ),
  ];

  // A detector count discontinuity can split one real camera shot into
  // auxiliary layout windows. If that source shot ever shows a crowd, none
  // of those windows is eligible for an automatic person crop or two-up.
  // Use the admitted samples and source cuts only: the auxiliary cuts above
  // must not let a brief two-face portion hide the wider group context.
  const sourceShots = segmentShots(params.sceneCuts, params.durationSec);
  const crowdedSourceShots = sourceShots.filter((sourceShot) =>
    samples.some(
      (sample) =>
        sample.t >= sourceShot.startSec &&
        sample.t < sourceShot.endSec &&
        sample.faces.length > 2,
    ),
  );
  const shots = segmentShots(allCuts, params.durationSec);
  const analyses = shots.map((shot) =>
    analyzeShot(shot, samples, opts.analyzeOptions),
  );

  const anyFaces = analyses.some((a) => a.kind !== "none");
  if (!anyFaces) {
    // Detection covered the clip and found no faces. That is still useful
    // evidence: preserve each source shot with a full-source fit rather than
    // pretending an earlier crop or generic center fallback applies.
    return {
      ...empty(analyses),
      segments: analyses.map(({ shot }) => ({
        startSec: shot.startSec,
        endSec: shot.endSec,
        layout: "single" as const,
        intent: "fit" as const,
        cxNorm: 0.5,
        cyNorm: 0.5,
        zoom: 1,
        subjects: [],
      })),
    };
  }

  const turns = buildSpeakerTurns(params.words, opts.turnsOptions);

  const segments: ClipAutoLayoutSegment[] = [];
  let mappedSpeakerCount = 0;
  let twoUpSegmentCount = 0;

  for (const [shotIndex, analysis] of analyses.entries()) {
    const { shot, kind, seats } = analysis;
    const subjects: ClipAutoLayoutSubject[] = analysis.subjectSeats
      .slice(0, 4)
      .map((seat, subjectIndex) => {
        const framed = frameFaceInCrop(seat, 1, opts.frameOptions);
        return {
          id: `shot:${shotIndex}:subject:${subjectIndex}`,
          cxNorm: framed.cxNorm,
          cyNorm: framed.cyNorm,
          zoom: framed.zoom,
        };
      });

    const sourceShotIsCrowded = crowdedSourceShots.some(
      (sourceShot) =>
        shot.startSec >= sourceShot.startSec && shot.endSec <= sourceShot.endSec,
    );
    if (sourceShotIsCrowded) {
      segments.push({
        startSec: shot.startSec,
        endSec: shot.endSec,
        layout: "single",
        intent: "fit",
        cxNorm: 0.5,
        cyNorm: 0.5,
        zoom: 1,
        subjects,
      });
      continue;
    }

    if (kind === "none") {
      // A real cut with no face is B-roll, graphics, or a slide. It must see
      // the full source, never inherit a nearby person's crop. Within-shot
      // detector gaps are covered by the track above, so this branch only
      // handles a whole shot with no trustworthy face.
      segments.push({
        startSec: shot.startSec,
        endSec: shot.endSec,
        layout: "single",
        intent: "fit",
        cxNorm: 0.5,
        cyNorm: 0.5,
        zoom: 1,
        subjects: [],
      });
      continue;
    }

    if (kind === "solo") {
      const framed = frameFaceInCrop(seats[0]!, 1, opts.frameOptions);
      segments.push({
        startSec: shot.startSec,
        endSec: shot.endSec,
        layout: "single",
        cxNorm: framed.cxNorm,
        cyNorm: framed.cyNorm,
        zoom: framed.zoom,
        cropTrack: cropTrackForSeat(shot, samples, seats[0]!, 1, framed.zoom, opts.frameOptions),
        subjects,
      });
      continue;
    }

    if (analysis.subjectSeats.length !== 2) {
      // A crowd can collapse to two lateral detector clusters, but it is not
      // a two-person conversation. Keep every visible person in source fit
      // rather than making stacked copies of a partial wide shot.
      segments.push({
        startSec: shot.startSec,
        endSec: shot.endSec,
        layout: "single",
        intent: "fit",
        cxNorm: 0.5,
        cyNorm: 0.5,
        zoom: 1,
        subjects,
      });
      continue;
    }

    // Multi-face shot. Prominence = the two largest seats, in left-to-right
    // order for stable top/bottom tile assignment (left seat on top, the
    // same convention split mode ships with).
    const [seatA, seatB] = [...seats]
      .slice(0, 2)
      .sort((a, b) => a.cx - b.cx) as [ShotSeat, ShotSeat];

    // Voice-to-face association is still measured for diagnostics and an
    // opt-in active-speaker style, but shot topology owns the default layout.
    // The Vizard reference held a balanced two-person shot as two-up for more
    // than forty seconds despite multiple turns; word-level cutting here
    // would be both less faithful and more error-prone.
    const seatMap = assignSeatsToSpeakers(
      seats,
      shot,
      samples,
      turns,
      opts.assignOptions,
    );
    mappedSpeakerCount = Math.max(mappedSpeakerCount, seatMap.size);
    if (activeSpeakerCuts && seatMap.size > 0) {
      const filler = (
        startSec: number,
        endSec: number,
      ): ClipAutoLayoutSegment => {
        if (params.allowTwoUp) {
          const fA = frameFaceInCrop(seatA, 1, opts.frameOptions);
          const fB = frameFaceInCrop(seatB, 1, opts.frameOptions);
          return {
            startSec,
            endSec,
            layout: "two-up",
            topCxNorm: fA.cxNorm,
            bottomCxNorm: fB.cxNorm,
            topCyNorm: fA.cyNorm,
            bottomCyNorm: fB.cyNorm,
            topZoom: fA.zoom,
            bottomZoom: fB.zoom,
            subjects,
          };
        }
        const spread = Math.abs(seatA.cx - seatB.cx);
        if (spread < 0.3) {
          return {
            startSec,
            endSec,
            layout: "single",
            cxNorm: (seatA.cx + seatB.cx) / 2,
            cyNorm: (seatA.cy + seatB.cy) / 2,
            zoom: 1,
            subjects,
          };
        }
        const framed = frameFaceInCrop(seats[0]!, 1, opts.frameOptions);
        return {
          startSec,
          endSec,
          layout: "single",
          cxNorm: framed.cxNorm,
          cyNorm: framed.cyNorm,
          zoom: framed.zoom,
          subjects,
        };
      };

      // Solo intervals: mapped speakers' turns overlapping this shot with
      // enough overlap to earn a full-frame cut.
      const intervals: Array<{ startSec: number; endSec: number; seat: number }> = [];
      for (const turn of turns) {
        const seat = seatMap.get(turn.speaker);
        if (seat === undefined) continue;
        const s = Math.max(turn.startSec, shot.startSec);
        const e = Math.min(turn.endSec, shot.endSec);
        if (e - s < turnSoloMinSec) continue;
        intervals.push({ startSec: s, endSec: e, seat });
      }
      intervals.sort((a, b) => a.startSec - b.startSec);
      // Merge same-seat neighbors and absorb short gaps into the PREVIOUS
      // interval (hold the current speaker through pauses) so a breath
      // can't flash the split.
      const merged: typeof intervals = [];
      for (const iv of intervals) {
        const last = merged[merged.length - 1];
        if (last && iv.startSec - last.endSec <= holdGapSec) {
          if (last.seat === iv.seat) {
            last.endSec = Math.max(last.endSec, iv.endSec);
            continue;
          }
          last.endSec = iv.startSec; // hand off exactly at the next turn
        }
        merged.push({ ...iv });
      }

      let cursor = shot.startSec;
      const shotSegments: ClipAutoLayoutSegment[] = [];
      for (const iv of merged) {
        if (iv.startSec - cursor > 0) {
          if (iv.startSec - cursor <= holdGapSec && shotSegments.length === 0) {
            iv.startSec = cursor; // leading sliver joins the first solo
          } else if (iv.startSec - cursor <= holdGapSec) {
            shotSegments[shotSegments.length - 1]!.endSec = iv.startSec; // hold previous
          } else {
            shotSegments.push(filler(cursor, iv.startSec));
          }
        }
        const framed = frameFaceInCrop(seats[iv.seat]!, 1, opts.frameOptions);
        shotSegments.push({
          startSec: iv.startSec,
          endSec: iv.endSec,
          layout: "single",
          cxNorm: framed.cxNorm,
          cyNorm: framed.cyNorm,
          zoom: framed.zoom,
          subjects,
        });
        cursor = iv.endSec;
      }
      if (shot.endSec - cursor > 0) {
        if (shot.endSec - cursor <= holdGapSec && shotSegments.length > 0) {
          shotSegments[shotSegments.length - 1]!.endSec = shot.endSec;
        } else {
          shotSegments.push(filler(cursor, shot.endSec));
        }
      }
      for (const seg of shotSegments) {
        if (seg.layout === "two-up") twoUpSegmentCount += 1;
      }
      segments.push(...shotSegments);
      continue;
    }

    const shotLen = shot.endSec - shot.startSec;
    const shares = speechShareInWindow(turns, shot.startSec, shot.endSec);
    const totalSpeech = [...shares.values()].reduce((sum, v) => sum + v, 0);
    let dominantSeat: ShotSeat | null = null;
    if (shotLen >= dominantShotMinSec && totalSpeech > 0) {
      const top = [...shares.entries()].sort((a, b) => b[1] - a[1])[0]!;
      if (top[1] / totalSpeech >= dominantShareMin) {
        // HONEST SCOPE (adversarial review M1): diarization only ENABLES
        // this demotion ("one voice held the whole shot, so a single crop
        // won't cut away from an active exchange") — it does NOT identify
        // WHICH seat the diarized label occupies; no label->seat mapping
        // is trusted for this default-path decision. Although the engine
        // separately computes a confidence-scored voice-to-seat map for
        // diagnostics and the opt-in active-speaker style, the calm Vizard-
        // parity default remains purely compositional: only when one face is
        // markedly larger (ratio
        // > 1.35 — the shot is composed on that person) do we trust a
        // single crop of it; equal-billing two-person seats keep the split.
        const larger = seats[0]!;
        const secondLargest = seats[1]!;
        if (larger.h / Math.max(secondLargest.h, 1e-6) > 1.35) {
          dominantSeat = larger;
        }
      }
    }

    if (dominantSeat) {
      const framed = frameFaceInCrop(dominantSeat, 1, opts.frameOptions);
      segments.push({
        startSec: shot.startSec,
        endSec: shot.endSec,
        layout: "single",
        cxNorm: framed.cxNorm,
        cyNorm: framed.cyNorm,
        zoom: framed.zoom,
        cropTrack: cropTrackForSeat(shot, samples, dominantSeat, 1, framed.zoom, opts.frameOptions),
        subjects,
      });
      continue;
    }

    // A stacked layout needs two actual camera seats. Small or intermittent
    // faces in a photo, audience, or wide B-roll frame are not speakers and
    // duplicating that source into two tiles looks worse than one honest crop.
    const canUseTwoUp =
      params.allowTwoUp &&
      seats.length === 2 &&
      analysis.subjectSeats.length === 2 &&
      seatA.presence >= 0.55 &&
      seatB.presence >= 0.55 &&
      seatA.h >= 0.1 &&
      seatB.h >= 0.1 &&
      Math.abs(seatA.cx - seatB.cx) >= 0.28;
    if (canUseTwoUp) {
      // Two-up tiles are near-square (W x H/2), so the base tile crop
      // typically keeps full source height — frame each seat within it.
      const framedA = frameFaceInCrop(seatA, 1, opts.frameOptions);
      const framedB = frameFaceInCrop(seatB, 1, opts.frameOptions);
      segments.push({
        startSec: shot.startSec,
        endSec: shot.endSec,
        layout: "two-up",
        topCxNorm: framedA.cxNorm,
        bottomCxNorm: framedB.cxNorm,
        topCyNorm: framedA.cyNorm,
        bottomCyNorm: framedB.cyNorm,
        topZoom: framedA.zoom,
        bottomZoom: framedB.zoom,
        topCropTrack: cropTrackForSeat(shot, samples, seatA, 1, framedA.zoom, opts.frameOptions),
        bottomCropTrack: cropTrackForSeat(shot, samples, seatB, 1, framedB.zoom, opts.frameOptions),
        subjects,
      });
      twoUpSegmentCount += 1;
      continue;
    }

    // This output cannot show distinct tiles and no subject earned a
    // dominant crop. Source fit keeps both observed people visible.
    segments.push({
      startSec: shot.startSec,
      endSec: shot.endSec,
      layout: "single",
      intent: "fit",
      cxNorm: 0.5,
      cyNorm: 0.5,
      zoom: 1,
      subjects,
    });
  }

  return {
    // Keep real source cuts. A camera change is more important than saving a
    // filter branch, and tracks already avoid turning within-shot movement
    // into a sequence of scenes.
    segments,
    shotCount: analyses.length,
    soloShotCount: analyses.filter((a) => a.kind === "solo").length,
    multiShotCount: analyses.filter((a) => a.kind === "multi").length,
    twoUpSegmentCount,
    speakerCount: new Set(params.words.map((w) => w.speaker)).size,
    mappedSpeakerCount,
  };
}
