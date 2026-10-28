import { describe, expect, test } from "bun:test";
import {
  AUTO_CENSOR_POLICY_VERSION,
  censorSegmentSchema,
  normalizeCensorAudioSchedule,
  type AutoCensorSuggestion,
  type CensorSegment,
} from "@narriflow/validators";
import {
  autoCensorEffectsValid,
  buildCensorSegments,
  censorMarkersByWordId,
  censorChanges,
  describeCensorEffects,
  hasCensorChanges,
  groupAppliedCensorSegments,
  type AutoCensorEffects,
} from "./auto-censor-review-model";

function suggestion(overrides: Partial<AutoCensorSuggestion> = {}): AutoCensorSuggestion {
  return {
    fingerprint: "a".repeat(64),
    policyVersion: AUTO_CENSOR_POLICY_VERSION,
    policySource: "workspace",
    policyCategory: "profanity",
    matchedText: "masked",
    contextBefore: "before",
    contextAfter: "after",
    sourceWordIds: ["word:one"],
    sourceStartSec: 1,
    sourceEndSec: 1.3,
    audioStartSec: 0.95,
    audioEndSec: 1.35,
    confidence: 0.9,
    timingLimitation: null,
    ...overrides,
  };
}

let nextId = 0;
const createId = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
const both: AutoCensorEffects = { textStyle: "first_last", sound: "beep" };
const build = (
  suggestions: AutoCensorSuggestion[],
  existing: CensorSegment[] = [],
  effects: AutoCensorEffects = both,
) => buildCensorSegments({ suggestions, existing, canApply: true, effects, paddingSec: 0.08, createId });

describe("Auto Censor apply", () => {
  test("gives each match a caption segment and a beep on the same span", () => {
    const result = build([suggestion()]);
    expect(result.words).toBe(1);
    expect(result.applied).toHaveLength(2);
    const caption = result.applied.find((segment) => segment.treatment === "caption_mask")!;
    const beep = result.applied.find((segment) => segment.treatment === "beep")!;
    expect(caption).toMatchObject({
      captionMaskPolicy: { replacement: "first_last", preservePunctuation: true },
      beepSettings: null,
      sourceWordIds: ["word:one"],
      sourceStartSec: 1,
      sourceEndSec: 1.3,
    });
    expect(beep).toMatchObject({
      beepSettings: { frequencyHz: 1_000, levelDb: -8 },
      captionMaskPolicy: null,
      paddingSec: 0.08,
      sourceWordIds: ["word:one"],
    });
    for (const segment of result.applied) expect(censorSegmentSchema.safeParse(segment).success).toBe(true);
    expect(result.segments).toEqual(result.applied);
  });

  test("masks only, or sounds only, when the other is off", () => {
    const mask = build([suggestion()], [], { textStyle: "asterisks", sound: "none" });
    expect(mask.applied.map((segment) => segment.treatment)).toEqual(["caption_mask"]);
    expect(mask.applied[0]?.captionMaskPolicy?.replacement).toBe("asterisks");
    const mute = build([suggestion()], [], { textStyle: "none", sound: "mute" });
    expect(mute.applied.map((segment) => segment.treatment)).toEqual(["mute"]);
    expect(mute.applied[0]).toMatchObject({ beepSettings: null, captionMaskPolicy: null });
  });

  test("requires at least one of mask and sound", () => {
    const neither: AutoCensorEffects = { textStyle: "none", sound: "none" };
    expect(autoCensorEffectsValid(neither)).toBe(false);
    expect(autoCensorEffectsValid(both)).toBe(true);
    expect(() => build([suggestion()], [], neither)).toThrow("auto_censor_nothing_to_apply");
  });

  test("keeps preview read-only without the plan feature", () => {
    expect(() => buildCensorSegments({
      suggestions: [suggestion()], existing: [], canApply: false, effects: both, paddingSec: 0.06, createId,
    })).toThrow("plan_feature_required");
  });

  test("never duplicates a kind on a span, even after the document revision changes the fingerprint", () => {
    const first = build([suggestion()]);
    const again = build([suggestion({ fingerprint: "b".repeat(64) })], first.segments);
    expect(again.applied).toEqual([]);
    expect(again.words).toBe(0);
    expect(again.segments).toEqual(first.segments);
  });

  test("adds only the missing kind when an earlier apply left one out", () => {
    const maskOnly = build([suggestion()], [], { textStyle: "first_last", sound: "none" });
    const next = build([suggestion()], maskOnly.segments);
    expect(next.applied.map((segment) => segment.treatment)).toEqual(["beep"]);
    expect(next.segments).toHaveLength(2);
    expect(hasCensorChanges(censorChanges(suggestion(), next.segments, both))).toBe(false);
  });

  test("switching the text style rewrites the caption segment in place", () => {
    const first = build([suggestion()]);
    const captionId = first.segments.find((segment) => segment.treatment === "caption_mask")!.id;
    const asterisks: AutoCensorEffects = { textStyle: "asterisks", sound: "beep" };
    expect(hasCensorChanges(censorChanges(suggestion(), first.segments, asterisks))).toBe(true);
    const next = build([suggestion()], first.segments, asterisks);
    expect(next.words).toBe(1);
    expect(next.segments).toHaveLength(2);
    const caption = next.segments.find((segment) => segment.treatment === "caption_mask")!;
    expect(caption.id).toBe(captionId);
    expect(caption.captionMaskPolicy?.replacement).toBe("asterisks");
    expect(next.segments.find((segment) => segment.treatment === "beep")?.id)
      .toBe(first.segments.find((segment) => segment.treatment === "beep")!.id);
  });

  test("switching between beep and mute rewrites the audio segment in place", () => {
    const first = build([suggestion()]);
    const audioId = first.segments.find((segment) => segment.treatment === "beep")!.id;
    const mute = build([suggestion()], first.segments, { textStyle: "first_last", sound: "mute" });
    expect(mute.segments).toHaveLength(2);
    const audio = mute.segments.find((segment) => segment.treatment === "mute")!;
    expect(audio).toMatchObject({ id: audioId, beepSettings: null, captionMaskPolicy: null });
    expect(censorSegmentSchema.safeParse(audio).success).toBe(true);
    const back = build([suggestion()], mute.segments);
    expect(back.segments.find((segment) => segment.id === audioId)).toMatchObject({
      treatment: "beep", beepSettings: { frequencyHz: 1_000, levelDb: -8 },
    });
  });

  test("applying turns a disabled word back on instead of calling it done", () => {
    const first = build([suggestion()]);
    const off = first.segments.map((segment) => ({ ...segment, enabled: false }));
    expect(hasCensorChanges(censorChanges(suggestion(), off, both))).toBe(true);
    const next = build([suggestion()], off);
    expect(next.segments).toHaveLength(2);
    expect(next.segments.every((segment) => segment.enabled)).toBe(true);
    expect(next.segments.map((segment) => segment.id).sort()).toEqual(off.map((segment) => segment.id).sort());
  });

  test("Don't mask and Sound None remove that kind from the word", () => {
    const first = build([suggestion()]);
    const noMask = build([suggestion()], first.segments, { textStyle: "none", sound: "beep" });
    expect(noMask.segments.map((segment) => segment.treatment)).toEqual(["beep"]);
    expect(noMask.words).toBe(1);
    const noSound = build([suggestion()], first.segments, { textStyle: "first_last", sound: "none" });
    expect(noSound.segments.map((segment) => segment.treatment)).toEqual(["caption_mask"]);
    // Nothing is left to remove the second time.
    expect(hasCensorChanges(censorChanges(suggestion(), noSound.segments, { textStyle: "first_last", sound: "none" }))).toBe(false);
  });

  test("never leaves two segments of one kind on a span", () => {
    const first = build([suggestion()]);
    const dupe = { ...first.segments[0]!, id: "00000000-0000-4000-8000-0000000000ff" };
    const next = build([suggestion()], [...first.segments, dupe]);
    expect(next.segments).toHaveLength(2);
  });

  test("leaves untimed matches alone", () => {
    const untimed = suggestion({ sourceStartSec: null, sourceEndSec: null, timingLimitation: "caption_only" });
    expect(build([untimed]).applied).toEqual([]);
  });

  test("skips a match whole when its pair would pass the document's segment limit", () => {
    const filler = build(Array.from({ length: 127 }, (_, index) =>
      suggestion({ fingerprint: `${index}`.padStart(64, "c"), sourceWordIds: [`word:${index}`] })));
    expect(filler.segments).toHaveLength(254);
    const result = build([
      suggestion({ sourceWordIds: ["word:a"] }),
      suggestion({ sourceWordIds: ["word:b"] }),
    ], filler.segments);
    expect(result.words).toBe(1);
    expect(result.overLimit).toBe(1);
    expect(result.segments).toHaveLength(256);
  });

  test("describes what happened for the confirmation", () => {
    expect(describeCensorEffects(both)).toBe("captions masked, beeped");
    expect(describeCensorEffects({ textStyle: "none", sound: "mute" })).toBe("captions left unmasked, muted");
  });
});

describe("applied censor groups", () => {
  test("show one row per word and carry its mask and sound", () => {
    const { segments } = build([
      suggestion(),
      suggestion({ sourceWordIds: ["word:two"], sourceStartSec: 0.2, sourceEndSec: 0.5 }),
    ]);
    const groups = groupAppliedCensorSegments(segments);
    expect(groups.map((group) => group.sourceWordIds)).toEqual([["word:two"], ["word:one"]]);
    expect(groups[0]).toMatchObject({ sound: "beep", maskPolicy: { replacement: "first_last" }, enabled: true });
    expect(groups[0]?.segmentIds).toHaveLength(2);
    // Removing a word's group removes both of its segments.
    const removed = new Set(groups[0]!.segmentIds);
    expect(segments.filter((segment) => !removed.has(segment.id))).toHaveLength(2);
  });

  test("count as off when either piece is off", () => {
    const { segments } = build([suggestion()]);
    const disabled = segments.map((segment, index) => (index === 0 ? { ...segment, enabled: false } : segment));
    expect(groupAppliedCensorSegments(disabled)[0]?.enabled).toBe(false);
  });
});

describe("transcript markers", () => {
  test("combine an enabled mask and sound per word and ignore disabled segments", () => {
    const { segments } = build([suggestion()]);
    expect(censorMarkersByWordId(segments).get("word:one")).toEqual({
      maskPolicy: { replacement: "first_last", preservePunctuation: true },
      sound: "beep",
    });
    expect(censorMarkersByWordId(segments.map((segment) => ({ ...segment, enabled: false }))).size).toBe(0);
    const soundOnly = build([suggestion()], [], { textStyle: "none", sound: "mute" }).segments;
    expect(censorMarkersByWordId(soundOnly).get("word:one")).toEqual({ maskPolicy: null, sound: "mute" });
  });
});

describe("a masked and bleeped word", () => {
  test("the audio schedule carries only the bleep; the caption segment does not touch audio", () => {
    const { segments } = build([suggestion()]);
    const schedule = normalizeCensorAudioSchedule({
      clipWindow: { startSec: 0, endSec: 5 },
      deletedRanges: [],
      segments,
    });
    expect(schedule).toHaveLength(1);
    expect(schedule[0]).toMatchObject({ treatment: "beep", frequencyHz: 1_000, startSec: 0.92, endSec: 1.38 });
  });
});
