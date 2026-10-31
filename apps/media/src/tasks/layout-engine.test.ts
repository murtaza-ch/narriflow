import { describe, expect, it } from "bun:test";
import { CLIP_AUTO_LAYOUT_ENGINE, CLIP_AUTO_LAYOUT_VERSION, clipAutoLayoutAnalysisSchema, type TranscriptUtterance } from "@narriflow/validators";
import { buildClipCutPlan } from "./cut-plan";
import {
  analyzeShot,
  assignSeatsToSpeakers,
  buildAutoLayoutPlan,
  shotShowsGraphics,
  buildSpeakerTurns,
  deriveFaceDiscontinuityCuts,
  frameFaceInCrop,
  filterAutomaticFaceSamples,
  segmentShots,
  speechWordsFromUtterances,
  type SpeechWord,
} from "./layout-engine";
import type { MultiFaceSample } from "./two-up";

const UNCUT = buildClipCutPlan([], { startSec: 100, endSec: 160 });

function utterance(
  speaker: string,
  startSec: number,
  endSec: number,
  wordCount = 4,
): TranscriptUtterance {
  const words = Array.from({ length: wordCount }, (_, i) => {
    const step = (endSec - startSec) / wordCount;
    return {
      word: `w${i}`,
      startSec: startSec + i * step,
      endSec: startSec + (i + 1) * step,
      confidence: null,
    };
  });
  return {
    index: 0,
    speaker: null,
    speakerLabel: speaker,
    startSec,
    endSec,
    text: "x",
    confidence: null,
    words,
  };
}

/** A face at cx with plausible size and optional mouth/upper-face motion. */
function face(cx: number, cy = 0.4, h = 0.2, m?: number, fm?: number) {
  return { cx, cy, w: h * 0.75, h, score: 0.9, m: m ?? null, fm: fm ?? null };
}

/** A talking face (mouth churns much more than upper face). */
const talking = (cx: number) => face(cx, 0.4, 0.13, 0.08, 0.03);
/** A quietly listening face. */
const listening = (cx: number) => face(cx, 0.42, 0.13, 0.02, 0.03);

/** Samples at `fps` over [0, duration): every sample gets faces from `at`. */
function samplesOver(
  duration: number,
  at: (t: number) => ReturnType<typeof face>[],
  fps = 4,
): MultiFaceSample[] {
  const out: MultiFaceSample[] = [];
  for (let t = 0; t < duration; t += 1 / fps) {
    out.push({ t: Math.round(t * 1000) / 1000, faces: at(t) });
  }
  return out;
}

describe("speechWordsFromUtterances", () => {
  it("converts source-absolute word times to clip-relative on an uncut clip", () => {
    const words = speechWordsFromUtterances(
      [utterance("A", 110, 112)],
      UNCUT,
      100,
      160,
    );
    expect(words.length).toBe(4);
    expect(words[0]!.startSec).toBeCloseTo(10, 5);
    expect(words[3]!.endSec).toBeCloseTo(12, 5);
    expect(words[0]!.speaker).toBe("A");
  });

  it("drops words outside the clip window and clamps stragglers", () => {
    const words = speechWordsFromUtterances(
      [utterance("A", 90, 95), utterance("B", 158, 165, 2)],
      UNCUT,
      100,
      160,
    );
    expect(words.every((w) => w.startSec >= 0 && w.endSec <= 60)).toBe(true);
    expect(words.some((w) => w.speaker === "A")).toBe(false);
    expect(words.some((w) => w.speaker === "B")).toBe(true);
  });

  it("remaps through a cut plan (words inside a deleted range vanish)", () => {
    const cutPlan = buildClipCutPlan(
      [{ startSec: 120, endSec: 130 }],
      { startSec: 100, endSec: 160 },
    );
    const words = speechWordsFromUtterances(
      [utterance("A", 118, 122, 4), utterance("B", 135, 137, 2)],
      cutPlan,
      100,
      160,
    );
    // A's tail past 120 was cut; B's words shift left by the 10s cut.
    expect(Math.max(...words.filter((w) => w.speaker === "A").map((w) => w.endSec))).toBeLessThanOrEqual(20.001);
    const b = words.filter((w) => w.speaker === "B");
    expect(b[0]!.startSec).toBeCloseTo(25, 3);
  });

  it("uses the utterance span when word timings are missing", () => {
    const u = { ...utterance("A", 105, 108), words: [] };
    const words = speechWordsFromUtterances([u], UNCUT, 100, 160);
    expect(words.length).toBe(1);
    expect(words[0]!.startSec).toBeCloseTo(5, 5);
    expect(words[0]!.endSec).toBeCloseTo(8, 5);
  });
});

describe("buildSpeakerTurns", () => {
  it("merges consecutive same-speaker words and drops backchannels", () => {
    const words: SpeechWord[] = [
      { startSec: 0, endSec: 0.5, speaker: "A" },
      { startSec: 0.7, endSec: 1.4, speaker: "A" },
      { startSec: 1.6, endSec: 1.9, speaker: "B" }, // 0.3s backchannel
      { startSec: 2.0, endSec: 3.5, speaker: "A" },
    ];
    const turns = buildSpeakerTurns(words);
    // B's 0.3s "mm-hmm" is dropped; A's words split at B? No — A's words are
    // within maxGap of each other (2.0 - 1.4 = 0.6 <= 1.0), so one turn.
    expect(turns.length).toBe(1);
    expect(turns[0]!.speaker).toBe("A");
    expect(turns[0]!.endSec).toBeCloseTo(3.5, 5);
  });

  it("starts a new turn after a long same-speaker gap", () => {
    const words: SpeechWord[] = [
      { startSec: 0, endSec: 1, speaker: "A" },
      { startSec: 3, endSec: 4, speaker: "A" },
    ];
    const turns = buildSpeakerTurns(words);
    expect(turns.length).toBe(2);
  });
});

describe("segmentShots", () => {
  it("keeps adjacent source cuts", () => {
    const shots = segmentShots([5, 5.2, 12], 20);
    expect(shots.map((s) => [s.startSec, s.endSec])).toEqual([
      [0, 5],
      [5, 5.2],
      [5.2, 12],
      [12, 20],
    ]);
  });

  it("keeps a short tail after a source cut", () => {
    const shots = segmentShots([19.8], 20);
    expect(shots).toEqual([
      { startSec: 0, endSec: 19.8 },
      { startSec: 19.8, endSec: 20 },
    ]);
  });

  it("returns one full shot with no cuts", () => {
    expect(segmentShots([], 30)).toEqual([{ startSec: 0, endSec: 30 }]);
  });
});

describe("filterAutomaticFaceSamples", () => {
  it("rejects a lower-confidence static false positive while retaining a real face", () => {
    const samples: MultiFaceSample[] = [
      { t: 0, faces: [face(0.46, 0.39, 0.36), { ...face(0.74, 0.7, 0.41), score: 0.76 }] },
      { t: 0.25, faces: [face(0.45, 0.4, 0.35), { ...face(0.74, 0.7, 0.41), score: 0.82 }] },
    ];
    const admitted = filterAutomaticFaceSamples(samples);
    expect(admitted.map((sample) => sample.faces.length)).toEqual([1, 1]);
    expect(admitted.flatMap((sample) => sample.faces).every((candidate) => candidate.cx < 0.6)).toBe(true);
  });

  it("allows a weaker detection only as a continuation of a recent strong track", () => {
    const admitted = filterAutomaticFaceSamples([
      { t: 0, faces: [face(0.3)] },
      { t: 0.25, faces: [{ ...face(0.32), score: 0.7 }] },
      { t: 0.5, faces: [{ ...face(0.8), score: 0.7 }] },
    ]);
    expect(admitted.map((sample) => sample.faces.length)).toEqual([1, 1, 0]);
  });
});

describe("analyzeShot", () => {
  const shot = { startSec: 0, endSec: 10 };

  it("classifies a stable single face as solo", () => {
    const samples = samplesOver(10, () => [face(0.52, 0.42, 0.3)]);
    const analysis = analyzeShot(shot, samples);
    expect(analysis.kind).toBe("solo");
    expect(analysis.seats.length).toBe(1);
    expect(analysis.seats[0]!.cx).toBeCloseTo(0.52, 2);
    expect(analysis.subjectSeats).toHaveLength(1);
  });

  it("classifies two laterally distinct faces as multi with two seats", () => {
    const samples = samplesOver(10, () => [face(0.25, 0.4, 0.14), face(0.72, 0.42, 0.13)]);
    const analysis = analyzeShot(shot, samples);
    expect(analysis.kind).toBe("multi");
    expect(analysis.seats.length).toBe(2);
    expect(analysis.subjectSeats).toHaveLength(2);
  });

  it("discards a low-presence walk-through face", () => {
    const samples = samplesOver(10, (t) =>
      t < 1 ? [face(0.3), face(0.9, 0.5, 0.1)] : [face(0.3)],
    );
    const analysis = analyzeShot(shot, samples);
    expect(analysis.kind).toBe("solo");
  });

  it("classifies faceless footage as none", () => {
    const samples = samplesOver(10, () => []);
    expect(analyzeShot(shot, samples).kind).toBe("none");
  });

  it("C1 regression: alternating one-face close-ups are NOT a two-shot", () => {
    // A missed camera cut: the "shot" alternates between a close-up at cx
    // 0.30 and one at cx 0.72, never both at once. Two seats would render
    // a two-up of one person's face and their empty chair.
    const samples = samplesOver(10, (t) =>
      Math.floor(t / 2) % 2 === 0 ? [face(0.3, 0.4, 0.3)] : [face(0.72, 0.42, 0.3)],
    );
    const analysis = analyzeShot(shot, samples);
    expect(analysis.kind).toBe("solo");
    expect(analysis.seats.length).toBe(1);
    expect(analysis.subjectSeats).toHaveLength(1);
  });

  it("keeps a moving person as one subject when positions never co-occur", () => {
    const samples = samplesOver(10, (t) => [
      face(0.2 + 0.6 * (t / 10), 0.4, 0.2),
    ]);
    const analysis = analyzeShot(shot, samples);
    expect(analysis.subjectSeats).toHaveLength(1);
  });

  it("derives four distinct anchors only when four faces co-occur", () => {
    const samples = samplesOver(10, () => [
      face(0.14),
      face(0.38),
      face(0.62),
      face(0.86),
    ]);
    const analysis = analyzeShot(shot, samples);
    expect(analysis.subjectSeats).toHaveLength(4);
    expect(analysis.subjectSeats.map((subject) => subject.cx)).toEqual([
      0.14, 0.38, 0.62, 0.86,
    ]);
  });

  it("keeps four co-occurring subjects when Automatic seat clustering merges them", () => {
    const samples = samplesOver(10, () => [
      face(0.35),
      face(0.45),
      face(0.55),
      face(0.65),
    ]);
    const analysis = analyzeShot(shot, samples);
    expect(analysis.kind).toBe("solo");
    expect(analysis.seats).toHaveLength(1);
    expect(analysis.subjectSeats.map((subject) => subject.cx)).toEqual([
      0.35, 0.45, 0.55, 0.65,
    ]);
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [],
      words: [],
      durationSec: 10,
      allowTwoUp: true,
    });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.layout).toBe("single");
    expect(plan.segments[0]!.subjects).toHaveLength(4);
  });

  it("keeps multi for a genuine two-shot with occasional single-face dropouts", () => {
    const samples = samplesOver(10, (t) =>
      Math.floor(t * 4) % 5 === 0
        ? [face(0.28, 0.4, 0.14)]
        : [face(0.28, 0.4, 0.14), face(0.7, 0.42, 0.13)],
    );
    expect(analyzeShot(shot, samples).kind).toBe("multi");
  });
});

describe("deriveFaceDiscontinuityCuts", () => {
  it("emits a cut on a single-face cx jump", () => {
    const samples = samplesOver(4, (t) =>
      t < 2 ? [face(0.3)] : [face(0.72)],
    );
    const cuts = deriveFaceDiscontinuityCuts(samples);
    expect(cuts.length).toBe(1);
    expect(cuts[0]!).toBeCloseTo(2, 1);
  });

  it("emits a cut on a persistent face-count change but not a one-sample dropout", () => {
    const twoFaces = [face(0.3, 0.4, 0.13), face(0.7, 0.42, 0.13)];
    const samples = samplesOver(6, (t) => {
      if (Math.abs(t - 1.44) < 0.01) return [face(0.3, 0.4, 0.13)]; // dropout
      return t < 4 ? twoFaces : [face(0.5, 0.42, 0.3)];
    });
    const cuts = deriveFaceDiscontinuityCuts(samples);
    expect(cuts.some((c) => Math.abs(c - 4) < 0.3)).toBe(true);
    expect(cuts.some((c) => Math.abs(c - 1.44) < 0.2)).toBe(false);
  });

  it("stays silent on a stable track", () => {
    expect(deriveFaceDiscontinuityCuts(samplesOver(8, () => [face(0.5)]))).toEqual([]);
  });
});

describe("frameFaceInCrop", () => {
  it("scales headroom with the actual crop height and bounds source coordinates", () => {
    const seat = { cx: 0.5, cy: 0.4, h: 0.1 };
    for (const baseCropHFrac of [1, 0.75, 0.4]) {
      const framed = frameFaceInCrop(seat, baseCropHFrac, { maxZoom: 1.1, headroomFrac: 0.35 });
      expect(framed.cyNorm).toBeCloseTo(seat.cy + 0.15 * baseCropHFrac / framed.zoom, 8);
    }
    expect(frameFaceInCrop({ ...seat, cy: 0.98 }, 1).cyNorm).toBe(1);
  });

  it("zooms a small face toward the target fraction, capped at maxZoom", () => {
    const framed = frameFaceInCrop({ cx: 0.3, cy: 0.4, h: 0.1 }, 1);
    expect(framed.zoom).toBeCloseTo(1.4, 5); // 0.26/0.1 = 2.6, capped
    const larger = frameFaceInCrop({ cx: 0.3, cy: 0.4, h: 0.2 }, 1);
    expect(larger.zoom).toBeCloseTo(1.3, 5);
  });

  it("never zooms out for an already-large face", () => {
    const framed = frameFaceInCrop({ cx: 0.5, cy: 0.45, h: 0.4 }, 1);
    expect(framed.zoom).toBe(1);
  });

  it("places the face above crop center (headroom)", () => {
    const framed = frameFaceInCrop({ cx: 0.5, cy: 0.4, h: 0.26 }, 1);
    // zoom = 1 -> cropH = 1 -> cy = 0.4 + (0.5 - 0.42) * 1 = 0.48: crop
    // center sits below the face center, i.e. face rides high in frame.
    expect(framed.cyNorm).toBeGreaterThan(0.4);
    expect(framed.cyNorm).toBeLessThan(0.5);
  });

  it("degrades to a centered no-zoom crop without face size", () => {
    expect(frameFaceInCrop({ cx: 0.6, cy: 0.3, h: 0 }, 1)).toEqual({
      cxNorm: 0.6,
      cyNorm: 0.5,
      zoom: 1,
    });
  });
});

describe("assignSeatsToSpeakers", () => {
  const seats = [
    { cx: 0.25, cy: 0.4, h: 0.13, presence: 1 },
    { cx: 0.75, cy: 0.42, h: 0.13, presence: 1 },
  ];
  const shot = { startSec: 0, endSec: 16 };

  it("maps each speaker to the seat whose mouth activity tracks their turns", () => {
    const samples = samplesOver(16, (t) =>
      t < 8
        ? [talking(0.25), listening(0.75)]
        : [listening(0.25), talking(0.75)],
    );
    const turns = [
      { speaker: "A", startSec: 0, endSec: 7.8 },
      { speaker: "B", startSec: 8.1, endSec: 16 },
    ];
    const map = assignSeatsToSpeakers(seats, shot, samples, turns);
    expect(map.get("A")).toBe(0);
    expect(map.get("B")).toBe(1);
  });

  it("refuses to map when the signal is ambiguous", () => {
    // Both seats churn identically regardless of who is diarized.
    const samples = samplesOver(16, () => [
      face(0.25, 0.4, 0.13, 0.05, 0.03),
      face(0.75, 0.42, 0.13, 0.05, 0.03),
    ]);
    const turns = [
      { speaker: "A", startSec: 0, endSec: 7.8 },
      { speaker: "B", startSec: 8.1, endSec: 16 },
    ];
    expect(assignSeatsToSpeakers(seats, shot, samples, turns).size).toBe(0);
  });

  it("ignores crosstalk samples and refuses on thin evidence", () => {
    const samples = samplesOver(3, (_t) => [talking(0.25), listening(0.75)]);
    // Entire window is overlapping speech -> zero usable evidence.
    const overlap = [
      { speaker: "A", startSec: 0, endSec: 3 },
      { speaker: "B", startSec: 0, endSec: 3 },
    ];
    expect(assignSeatsToSpeakers(seats, shot, samples, overlap).size).toBe(0);
  });
});

describe("buildAutoLayoutPlan", () => {
  it("does not flash Fit after a camera cut rounded to detector milliseconds", () => {
    // Replay the confidence pattern at source 104.933s in MM-C3JqCXBk.
    // FFmpeg reports more precision than the detector's millisecond clock.
    const wide = (leftScore: number, rightScore: number) => [
      { ...face(0.17, 0.23, 0.11), score: leftScore },
      { ...face(0.81, 0.22, 0.12), score: rightScore },
    ];
    const plan = buildAutoLayoutPlan({
      samples: [
        { t: 0, faces: [face(0.54, 0.35, 0.4)] },
        { t: 0.667, faces: [face(0.54, 0.35, 0.4)] },
        { t: 0.933, faces: wide(0.849, 0.853) },
        { t: 1.2, faces: wide(0.836, 0.849) },
        { t: 1.467, faces: wide(0.868, 0.849) },
        ...samplesOver(4, () => wide(0.87, 0.86)).map((sample) => ({
          ...sample,
          t: sample.t + 1.733,
        })),
      ],
      sceneCuts: [0.933333],
      words: [],
      durationSec: 5.733,
      allowTwoUp: true,
    });
    expect(plan.segments.map(({ startSec, endSec, layout, ...segment }) => ({
      startSec, endSec, layout,
      intent: "intent" in segment ? segment.intent : undefined,
    }))).toEqual([
      { startSec: 0, endSec: 0.933333, layout: "single", intent: undefined },
      { startSec: 0.933333, endSec: 5.733, layout: "two-up", intent: undefined },
    ]);
  });

  /** Multicam scenario: solo A (0-8s), wide two-shot (8-16s), solo B (16-24s). */
  const soloA = (_t: number) => [face(0.5, 0.42, 0.28)];
  const wide = (_t: number) => [face(0.25, 0.4, 0.12), face(0.7, 0.42, 0.12)];
  const soloB = (_t: number) => [face(0.48, 0.44, 0.3)];
  const multicamSamples = samplesOver(24, (t) =>
    t < 8 ? soloA(t) : t < 16 ? wide(t) : soloB(t),
  );
  const multicamCuts = [8, 16];
  const wordsAlternating: SpeechWord[] = [
    { startSec: 0, endSec: 7.5, speaker: "A" },
    { startSec: 8, endSec: 11, speaker: "B" },
    { startSec: 11.2, endSec: 14, speaker: "A" },
    { startSec: 14.2, endSec: 16, speaker: "B" },
    { startSec: 16.2, endSec: 24, speaker: "B" },
  ];

  it("produces solo/two-up/solo segments for a multicam clip", () => {
    const plan = buildAutoLayoutPlan({
      samples: multicamSamples,
      sceneCuts: multicamCuts,
      words: wordsAlternating,
      durationSec: 24,
      allowTwoUp: true,
    });
    expect(plan.segments.length).toBe(3);
    expect(plan.segments[0]!.layout).toBe("single");
    expect(plan.segments[1]!.layout).toBe("two-up");
    expect(plan.segments[1]!.subjects).toHaveLength(2);
    expect(new Set(plan.segments[1]!.subjects.map((subject) => subject.id)).size).toBe(2);
    expect(plan.segments[2]!.layout).toBe("single");
    expect(plan.twoUpSegmentCount).toBe(1);
    // Solo segments are zoom-framed on the face.
    const first = plan.segments[0]!;
    if (first.layout === "single") {
      expect(first.cxNorm).toBeCloseTo(0.5, 1);
      expect(first.zoom ?? 1).toBeLessThanOrEqual(1.4);
    }
    // Segment boundaries land exactly on the scene cuts.
    expect(plan.segments[0]!.endSec).toBeCloseTo(8, 3);
    expect(plan.segments[1]!.endSec).toBeCloseTo(16, 3);
  });

  it("uses source fit for a two-subject shot when two-up is unavailable", () => {
    const plan = buildAutoLayoutPlan({
      samples: multicamSamples,
      sceneCuts: multicamCuts,
      words: wordsAlternating,
      durationSec: 24,
      allowTwoUp: false,
    });
    expect(plan.segments.every((s) => s.layout === "single")).toBe(true);
    const twoSubjectShot = plan.segments.find((segment) => segment.subjects.length === 2);
    expect(twoSubjectShot?.layout).toBe("single");
    if (twoSubjectShot?.layout === "single") {
      expect(twoSubjectShot.intent).toBe("fit");
    }
  });

  it("returns a face-centered plan for a single-camera talking head", () => {
    const samples = samplesOver(24, () => [face(0.5, 0.42, 0.25)]);
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [],
      words: [{ startSec: 0, endSec: 24, speaker: "A" }],
      durationSec: 24,
      allowTwoUp: true,
    });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.layout).toBe("single");
    if (plan.segments[0]!.layout === "single") {
      expect(plan.segments[0]!.cxNorm).toBeCloseTo(0.5, 1);
      // The crop center is shifted below the face to preserve intentional
      // headroom; it should remain stable and near frame center.
      expect(plan.segments[0]!.cyNorm).toBeCloseTo(0.5, 1);
    }
    expect(plan.shotCount).toBe(1);
    expect(plan.soloShotCount).toBe(1);
  });

  it("tracks a moving subject within one shot with constant zoom", () => {
    const plan = buildAutoLayoutPlan({
      samples: samplesOver(8, (timeSec) => [face(0.25 + timeSec * 0.05, 0.42, 0.24)]),
      sceneCuts: [],
      words: [],
      durationSec: 8,
      allowTwoUp: true,
    });
    const segment = plan.segments[0];
    expect(segment?.layout).toBe("single");
    if (segment?.layout === "single") {
      expect(segment.cropTrack?.length).toBeGreaterThan(2);
      expect(segment.cropTrack?.[0]?.cxNorm).toBeLessThan(
        segment.cropTrack?.at(-1)?.cxNorm ?? 0,
      );
      expect(segment.cropTrack?.[0]?.timeSec).toBe(0);
      expect(segment.cropTrack?.at(-1)?.timeSec).toBe(8);
    }
  });

  it("gives a stationary track exactly the same headroom as its static crop", () => {
    for (const cy of [0.35, 0.92]) {
      const plan = buildAutoLayoutPlan({
        samples: samplesOver(8, () => [face(0.5, cy, 0.2)]),
        sceneCuts: [], words: [], durationSec: 8, allowTwoUp: true,
        options: { frameOptions: { maxZoom: 1.1, headroomFrac: 0.3 } },
      });
      const segment = plan.segments[0];
      expect(segment?.layout).toBe("single");
      if (segment?.layout !== "single") throw new Error("expected single crop");
      expect(segment.cropTrack?.length).toBeGreaterThan(1);
      expect(segment.cropTrack?.every((point) => point.cyNorm === segment.cyNorm)).toBe(true);
    }
  });

  it("preserves the last observed center when a long crop track is decimated", () => {
    const plan = buildAutoLayoutPlan({
      // 32 samples exceed the 24-keyframe bound. Only the final frame moves,
      // so dropping it and duplicating an earlier point would freeze the end.
      samples: samplesOver(8, (timeSec) => [
        face(timeSec >= 7.75 ? 0.45 : 0.3, 0.42, 0.24),
      ]),
      sceneCuts: [],
      words: [],
      durationSec: 8,
      allowTwoUp: true,
    });
    const segment = plan.segments[0];
    expect(segment?.layout).toBe("single");
    if (segment?.layout === "single") {
      const track = segment.cropTrack ?? [];
      expect(track.length).toBeLessThanOrEqual(25);
      expect(track.at(-1)?.timeSec).toBe(8);
      expect(track.at(-1)?.cxNorm).toBeGreaterThan(0.4);
    }
  });

  it("continues following a fast camera pan after the subject leaves the shot median", () => {
    const plan = buildAutoLayoutPlan({
      // Each individual move is small enough to be a pan rather than a cut,
      // while the full travel is far beyond the old fixed 0.22 seat radius.
      samples: samplesOver(4, (timeSec) => [face(0.76 - timeSec * 0.15, 0.42, 0.3)]),
      sceneCuts: [],
      words: [],
      durationSec: 4,
      allowTwoUp: true,
    });
    const segment = plan.segments[0];
    expect(segment?.layout).toBe("single");
    if (segment?.layout === "single") {
      const track = segment.cropTrack ?? [];
      expect(track.length).toBeGreaterThan(2);
      expect(track[0]!.cxNorm - track.at(-1)!.cxNorm).toBeGreaterThan(0.45);
      // The adaptive response keeps the last face near its observed center
      // rather than letting the slow EMA leave it outside the crop.
      expect(track.at(-1)!.cxNorm).toBeLessThan(0.22);
    }
  });

  it("uses full-source fit for a crowded shot even when clustering finds two lateral groups", () => {
    const plan = buildAutoLayoutPlan({
      // Four simultaneous faces form two broad detector clusters. This is a
      // crowd, not the two distinct seats required for an automatic split.
      samples: samplesOver(8, () => [
        face(0.14, 0.4, 0.13),
        face(0.25, 0.42, 0.13),
        face(0.66, 0.4, 0.13),
        face(0.77, 0.42, 0.13),
      ]),
      sceneCuts: [],
      words: [],
      durationSec: 8,
      allowTwoUp: true,
    });
    const segment = plan.segments[0];
    expect(segment?.layout).toBe("single");
    if (segment?.layout === "single") {
      expect(segment.intent).toBe("fit");
      expect(segment.subjects).toHaveLength(4);
    }
    expect(plan.twoUpSegmentCount).toBe(0);
  });

  it("keeps every auxiliary window in source fit when its source shot grows from two faces to a crowd", () => {
    const samples = samplesOver(4, (timeSec) =>
      timeSec < 2
        ? [face(0.25, 0.4, 0.13), face(0.75, 0.42, 0.13)]
        // These three centers share one lateral cluster, so this auxiliary
        // window classifies solo despite three simultaneous subjects.
        : [face(0.35, 0.4, 0.13), face(0.44, 0.42, 0.13), face(0.53, 0.4, 0.13)],
    );
    expect(analyzeShot({ startSec: 2, endSec: 4 }, samples).kind).toBe("solo");
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [],
      words: [],
      durationSec: 4,
      allowTwoUp: true,
    });
    // The persistent 2 -> 3 count change produces an auxiliary cut, but the
    // source camera never cut. Its crowd context applies to both halves.
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments.map((segment) => segment.intent)).toEqual(["fit", "fit"]);
    expect(plan.segments.map((segment) => segment.subjects.length)).toEqual([2, 3]);
    expect(plan.twoUpSegmentCount).toBe(0);
  });

  it("returns full-source fit scenes when no faces exist at all", () => {
    const plan = buildAutoLayoutPlan({
      samples: samplesOver(20, () => []),
      sceneCuts: [5, 10],
      words: [],
      durationSec: 20,
      allowTwoUp: true,
    });
    expect(plan.segments).toHaveLength(3);
    expect(plan.segments.every((segment) => segment.layout === "single" && segment.intent === "fit")).toBe(true);
  });

  it("keeps a single dominant-speaker crop instead of a split when the shot composition favors one seat", () => {
    // Long wide shot, one speaker dominates, and the composition strongly
    // favors seat A (much larger face).
    const samples = samplesOver(20, () => [
      face(0.35, 0.4, 0.3),
      face(0.75, 0.45, 0.1),
    ]);
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [10],
      words: [
        { startSec: 0, endSec: 9, speaker: "A" },
        { startSec: 10.5, endSec: 19, speaker: "A" },
      ],
      durationSec: 20,
      allowTwoUp: true,
    });
    expect(plan.segments.every((s) => s.layout === "single")).toBe(true);
    for (const seg of plan.segments) {
      if (seg.layout === "single") expect(seg.cxNorm).toBeCloseTo(0.35, 1);
    }
  });

  it("keeps a balanced two-person shot stable by default across speaker turns", () => {
    // One 20s wide shot, no camera cuts. A talks 0-9, B talks 9.4-20 —
    // with the mouth signal attributing seats, each monologue renders as a
    // full-frame single of THAT seat, no static split.
    const samples = samplesOver(20, (t) =>
      t < 9
        ? [talking(0.25), listening(0.75)]
        : [listening(0.25), talking(0.75)],
    );
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [],
      words: [
        { startSec: 0, endSec: 9, speaker: "A" },
        { startSec: 9.4, endSec: 20, speaker: "B" },
      ],
      durationSec: 20,
      allowTwoUp: true,
    });
    expect(plan.mappedSpeakerCount).toBe(2);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.layout).toBe("two-up");
  });

  it("can opt into active-speaker cuts inside a wide shot", () => {
    const samples = samplesOver(20, (t) =>
      t < 9
        ? [talking(0.25), listening(0.75)]
        : [listening(0.25), talking(0.75)],
    );
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [],
      words: [
        { startSec: 0, endSec: 9, speaker: "A" },
        { startSec: 9.4, endSec: 20, speaker: "B" },
      ],
      durationSec: 20,
      allowTwoUp: true,
      options: { activeSpeakerCuts: true },
    });
    expect(plan.mappedSpeakerCount).toBe(2);
    const singles = plan.segments.filter((s) => s.layout === "single");
    expect(singles.length).toBe(2);
    if (singles[0]!.layout === "single") expect(singles[0]!.cxNorm).toBeCloseTo(0.25, 1);
    if (singles[1]!.layout === "single") expect(singles[1]!.cxNorm).toBeCloseTo(0.75, 1);
    expect(plan.segments.some((s) => s.layout === "two-up")).toBe(false);
    expect(singles[0]!.endSec).toBeCloseTo(9.4, 1);
  });

  it("keeps the split for stretches active-speaker mapping cannot attribute", () => {
    // Mapped speaker A talks 0-6; then 6-20 is an unmapped voice ("C",
    // never visually attributable because both seats stay quiet on camera).
    const samples = samplesOver(20, (t) =>
      t < 6
        ? [talking(0.25), listening(0.75)]
        : [listening(0.25), listening(0.75)],
    );
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [],
      words: [
        { startSec: 0, endSec: 6, speaker: "A" },
        { startSec: 6.5, endSec: 20, speaker: "C" },
      ],
      durationSec: 20,
      allowTwoUp: true,
      options: { activeSpeakerCuts: true },
    });
    expect(plan.mappedSpeakerCount).toBeGreaterThanOrEqual(1);
    // A's monologue is a single of the left seat; C's stretch is a split.
    expect(plan.segments[0]!.layout).toBe("single");
    expect(plan.segments.some((s) => s.layout === "two-up")).toBe(true);
  });

  it("splits a rapid exchange in a balanced wide shot", () => {
    const samples = samplesOver(12, () => [
      face(0.3, 0.4, 0.13),
      face(0.7, 0.42, 0.13),
    ]);
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [6],
      words: [
        { startSec: 0, endSec: 2, speaker: "A" },
        { startSec: 2.2, endSec: 4, speaker: "B" },
        { startSec: 4.2, endSec: 6, speaker: "A" },
        { startSec: 6.2, endSec: 8, speaker: "B" },
        { startSec: 8.2, endSec: 12, speaker: "A" },
      ],
      durationSec: 12,
      allowTwoUp: true,
    });
    expect(plan.segments.some((s) => s.layout === "two-up")).toBe(true);
    const twoUp = plan.segments.find((s) => s.layout === "two-up");
    if (twoUp && twoUp.layout === "two-up") {
      expect(twoUp.topCxNorm).toBeCloseTo(0.3, 1);
      expect(twoUp.bottomCxNorm).toBeCloseTo(0.7, 1);
      expect(twoUp.topZoom ?? 1).toBeGreaterThan(1);
    }
  });

  it("keeps consecutive source cuts even when their framing matches", () => {
    const samples = samplesOver(20, () => [face(0.5, 0.42, 0.28)]);
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [10],
      words: [{ startSec: 0, endSec: 20, speaker: "A" }],
      durationSec: 20,
      allowTwoUp: true,
    });
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0]!.endSec).toBeCloseTo(10, 3);
    expect(plan.segments[1]!.startSec).toBeCloseTo(10, 3);
  });

  it("keeps rapid source cuts as separate shots", () => {
    const shotLen = 0.7;
    const total = 14;
    const samples = samplesOver(total, (t) =>
      Math.floor(t / shotLen) % 2 === 0
        ? [face(0.25, 0.4, 0.25)]
        : [face(0.75, 0.42, 0.25)],
    );
    const cuts = Array.from({ length: 19 }, (_, i) => (i + 1) * shotLen);
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: cuts,
      words: [],
      durationSec: total,
      allowTwoUp: true,
    });
    expect(plan.segments).toHaveLength(20);
    for (const seg of plan.segments) {
      expect(seg.endSec - seg.startSec).toBeCloseTo(shotLen, 3);
    }
  });

  it("M2 regression: abandons the plan when detector samples end early", () => {
    // Samples stop at 15s of a 30s clip (decode failure) — the unseen tail
    // must not be center-cropped; fall back to EMA entirely.
    const samples = samplesOver(15, () => [face(0.3, 0.4, 0.25)]);
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [10, 20],
      words: [],
      durationSec: 30,
      allowTwoUp: true,
    });
    expect(plan.segments).toEqual([]);
  });

  it("uses full-source fit for a face-less shot instead of borrowing another shot crop", () => {
    const samples = samplesOver(24, (t) =>
      t < 8 ? [face(0.3, 0.4, 0.28)] : t < 16 ? [] : [face(0.72, 0.42, 0.28)],
    );
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: [8, 16],
      words: [],
      durationSec: 24,
      allowTwoUp: true,
    });
    const middle = plan.segments.find(
      (s) => s.startSec <= 8.01 && s.endSec >= 15.9,
    ) ?? plan.segments[1];
    expect(middle).toBeDefined();
    if (middle && middle.layout === "single") {
      expect(middle.intent).toBe("fit");
      expect(middle.cxNorm).toBe(0.5);
      expect(middle.subjects).toEqual([]);
    }
  });

  const footage = { edge: 0.06, text: 0.001 };
  const article = { edge: 0.45, text: 0.15 };
  const tweetOverPhoto = { edge: 0.19, text: 0.04 };
  const withContent = (samples: MultiFaceSample[], at: (t: number) => MultiFaceSample["content"]) =>
    samples.map((sample) => ({ ...sample, content: at(sample.t) }));

  it("fills the frame for faceless footage between person shots, centered and never borrowing a crop", () => {
    const samples = withContent(
      samplesOver(24, (t) => (t < 8 ? [face(0.3, 0.4, 0.28)] : t < 16 ? [] : [face(0.72, 0.42, 0.28)])),
      () => footage,
    );
    const plan = buildAutoLayoutPlan({ samples, sceneCuts: [8, 16], words: [], durationSec: 24, allowTwoUp: true });
    const middle = plan.segments[1]!;
    expect(middle).toMatchObject({ startSec: 8, endSec: 16, layout: "single", cxNorm: 0.5, cyNorm: 0.5, zoom: 1, subjects: [] });
    expect("intent" in middle ? middle.intent : undefined).toBeUndefined();
  });

  it("keeps full-source fit for faceless graphics and text over photos", () => {
    for (const graphics of [article, tweetOverPhoto]) {
      const samples = withContent(
        samplesOver(16, (t) => (t < 8 ? [face(0.3, 0.4, 0.28)] : [])),
        (t) => (t < 8 ? footage : graphics),
      );
      const plan = buildAutoLayoutPlan({ samples, sceneCuts: [8], words: [], durationSec: 16, allowTwoUp: true });
      expect(plan.segments[1]).toMatchObject({ layout: "single", intent: "fit" });
    }
  });

  it("decides each faceless shot by the majority of its samples", () => {
    // One motion-blurred transition frame reads as footage inside an article shot.
    const samples = withContent(samplesOver(8, () => []), (t) => (t === 4 ? footage : article));
    expect(shotShowsGraphics({ startSec: 0, endSec: 8 }, samples)).toBe(true);
    const footageShot = withContent(samplesOver(8, () => []), (t) => (t === 4 ? article : footage));
    expect(shotShowsGraphics({ startSec: 0, endSec: 8 }, footageShot)).toBe(false);
    // Without evidence (an older detector) the shot keeps the safe fit.
    expect(shotShowsGraphics({ startSec: 0, endSec: 8 }, samplesOver(8, () => []))).toBe(true);
  });

  it("gives every shot of a faceless clip its own decision", () => {
    const samples = withContent(samplesOver(20, () => []), (t) => (t < 10 ? footage : article));
    const plan = buildAutoLayoutPlan({ samples, sceneCuts: [10], words: [], durationSec: 20, allowTwoUp: true });
    expect(plan.segments.map((segment) => ("intent" in segment ? segment.intent : undefined))).toEqual([undefined, "fit"]);
  });

  /** Parses the plan exactly as the worker persists it. */
  const persist = (plan: ReturnType<typeof buildAutoLayoutPlan>, noSplit: ReturnType<typeof buildAutoLayoutPlan>, durationSec: number) =>
    clipAutoLayoutAnalysisSchema.parse({
      version: CLIP_AUTO_LAYOUT_VERSION, engine: CLIP_AUTO_LAYOUT_ENGINE, sourceIdentity: "source", analyzedAtISO: new Date(0).toISOString(),
      clipStartSec: 0, clipEndSec: durationSec, deletedRanges: [], editedDurationSec: durationSec, sourceWidth: 1920, sourceHeight: 1080,
      segments: plan.segments, noSplitSegments: noSplit.segments, shotCount: plan.shotCount, soloShotCount: plan.soloShotCount,
      multiShotCount: plan.multiShotCount, twoUpSegmentCount: plan.twoUpSegmentCount, speakerCount: plan.speakerCount, mappedSpeakerCount: plan.mappedSpeakerCount,
    });
  const planBoth = (samples: MultiFaceSample[], sceneCuts: number[], durationSec: number) => {
    const plan = buildAutoLayoutPlan({ samples, sceneCuts, words: [], durationSec, allowTwoUp: true });
    const noSplit = buildAutoLayoutPlan({ samples, sceneCuts, words: [], durationSec, allowTwoUp: false });
    return { plan, noSplit, analysis: persist(plan, noSplit, durationSec) };
  };

  it("gives a source cut a few frames inside either clip edge the neighbor's layout, keeping tracks valid", () => {
    const samples = withContent(
      samplesOver(12, (t) => (t < 11.9 ? [face(0.3 + t * 0.01, 0.4, 0.28)] : [])),
      () => article,
    );
    const { analysis } = planBoth(samples, [0.08, 11.92], 12);
    expect(analysis.segments).toHaveLength(1);
    const [segment] = analysis.segments;
    expect(segment).toMatchObject({ startSec: 0, endSec: 12, layout: "single" });
    expect(segment!.layout === "single" && segment!.intent).toBeFalsy();
    const track = segment!.layout === "single" ? segment!.cropTrack! : [];
    expect([track[0]!.timeSec, track.at(-1)!.timeSec]).toEqual([0, 12]);
  });

  it("keeps absorbing repeated edge cuts and retimes two-up tracks", () => {
    const pair = () => [face(0.25, 0.4, 0.2), face(0.75, 0.42, 0.2)];
    const samples = withContent(samplesOver(10, (t) => (t >= 0.12 && t < 9.88 ? pair() : [])), () => article);
    const { analysis } = planBoth(samples, [0.04, 0.12, 9.88, 9.96], 10);
    expect(analysis.segments.map((segment) => [segment.startSec, segment.endSec, segment.layout])).toEqual([[0, 10, "two-up"]]);
    expect(analysis.noSplitSegments).toHaveLength(1);
    expect(analysis.noSplitSegments[0]).toMatchObject({ startSec: 0, endSec: 10 });
  });

  it("applies each graphics threshold at its boundary", () => {
    const shot = { startSec: 0, endSec: 1 };
    const one = (content: { edge: number; text: number }) => [{ t: 0, faces: [], content }];
    expect(shotShowsGraphics(shot, one({ edge: 0.24, text: 0 }))).toBe(true);
    expect(shotShowsGraphics(shot, one({ edge: 0.239, text: 0 }))).toBe(false);
    expect(shotShowsGraphics(shot, one({ edge: 0.15, text: 0.02 }))).toBe(true);
    expect(shotShowsGraphics(shot, one({ edge: 0.149, text: 0.02 }))).toBe(false);
    expect(shotShowsGraphics(shot, one({ edge: 0.2, text: 0.019 }))).toBe(false);
    // A tie keeps fit: it never loses content.
    expect(shotShowsGraphics({ startSec: 0, endSec: 1 }, [
      { t: 0, faces: [], content: article }, { t: 0.5, faces: [], content: footage },
    ])).toBe(true);
  });

  it("decides an unsampled shot from the nearest sample", () => {
    const samples: MultiFaceSample[] = [{ t: 1, faces: [], content: footage }, { t: 3, faces: [], content: article }];
    expect(shotShowsGraphics({ startSec: 1.6, endSec: 1.8 }, samples)).toBe(false);
    expect(shotShowsGraphics({ startSec: 2.4, endSec: 2.6 }, samples)).toBe(true);
  });

  it("keeps runaway source cuts instead of merging cameras onto the wrong seat", () => {
    // 60 alternating-camera shots of 1s each.
    const samples = samplesOver(60, (t) =>
      Math.floor(t) % 2 === 0
        ? [face(0.3, 0.4, 0.25)]
        : [face(0.7, 0.42, 0.25)],
    );
    const cuts = Array.from({ length: 59 }, (_, i) => i + 1);
    const plan = buildAutoLayoutPlan({
      samples,
      sceneCuts: cuts,
      words: [],
      durationSec: 60,
      allowTwoUp: true,
    });
    expect(plan.segments).toHaveLength(60);
    // Coverage stays contiguous from 0 to duration.
    expect(plan.segments[0]!.startSec).toBe(0);
    expect(plan.segments[plan.segments.length - 1]!.endSec).toBeCloseTo(60, 3);
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i]!.startSec).toBeCloseTo(
        plan.segments[i - 1]!.endSec,
        5,
      );
    }
  });
});
