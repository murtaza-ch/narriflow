import { describe, expect, test } from "bun:test";
import { studioEditsSchema, type TranscriptUtterance } from "@narriflow/validators";
import { REMOVE_SILENCE_DEFAULTS, fillerCuts, silenceCuts, studioSilenceRanges } from "../../cleanup-cuts";
import { sceneLayoutEdits, wholeClipIsAuto } from "../layout-panel-model";
import {
  censorRowDescription,
  cleanupCutsDescription,
  emojiRowView,
  orderAiToolRows,
  reframeNote,
  rowControl,
  type AiToolRowState,
} from "./ai-tools-model";

/** Words as `[text, startSec, endSec]`. */
function utterance(index: number, words: readonly (readonly [string, number, number])[]): TranscriptUtterance {
  return {
    index,
    speaker: 0,
    speakerLabel: "A",
    startSec: words[0]![1],
    endSec: words.at(-1)![2],
    text: words.map(([word]) => word).join(" "),
    confidence: 0.9,
    words: words.map(([word, startSec, endSec]) => ({ word, startSec, endSec, confidence: 0.9 })),
  };
}

// Two pauses (2.5 s and 3 s) and two hesitations, as a talking-head clip reads.
const UTTERANCES = [
  utterance(0, [["So", 0.2, 0.5], ["um,", 0.6, 1.1], ["I", 1.3, 1.4], ["think", 1.4, 1.8], ["this", 1.8, 2.1], ["works.", 2.1, 3.0]]),
  utterance(1, [["Uh", 5.5, 5.9], ["it", 6.1, 6.3], ["really", 6.3, 6.8], ["does.", 6.8, 9.0]]),
  utterance(2, [["That", 12.0, 12.4], ["was", 12.4, 12.7], ["good.", 12.7, 15.0]]),
];
const WINDOW = { startSec: 0, endSec: 15.2 };
const input = { utterances: UTTERANCES, clipWindow: WINDOW, deletedRanges: [], quietRanges: null };

const SILENCES = { one: "silence", many: "silences" };

describe("Remove silences row", () => {
  test("shows what Apply would cut, from the popover's defaults", () => {
    const cuts = silenceCuts(input);
    expect(cuts.count).toBe(2);
    // The same ranges the timeline popover computes at its default slider positions.
    expect(cuts.ranges).toEqual(studioSilenceRanges(input, REMOVE_SILENCE_DEFAULTS));
    expect(cuts.removedSec).toBeCloseTo(cuts.ranges.reduce((sum, range) => sum + range.endSec - range.startSec, 0), 6);
    expect(cleanupCutsDescription(cuts, SILENCES, "No silences found")).toMatch(/^2 silences, \d+\.\d s shorter$/);
  });

  test("a clip whose pauses are already cut has nothing to offer", () => {
    const after = { ...input, deletedRanges: silenceCuts(input).ranges };
    const cuts = silenceCuts(after);
    expect(cuts.count).toBe(0);
    expect(cleanupCutsDescription(cuts, SILENCES, "No silences found")).toBe("No silences found");
  });

  test("measured quiet audio keeps a pause that has music in it", () => {
    // Only the first pause measured quiet: the second holds music.
    const cuts = silenceCuts({ ...input, quietRanges: [{ startSec: 3.0, endSec: 5.5 }] });
    expect(cuts.count).toBe(1);
    expect(cuts.ranges[0]!.endSec).toBeLessThanOrEqual(5.5);
  });

  test("one silence reads in the singular", () => {
    expect(cleanupCutsDescription({ count: 1, removedSec: 1.25 }, SILENCES, "none")).toBe("1 silence, 1.3 s shorter");
  });
});

describe("Remove filler words row", () => {
  test("English: counts each hesitation still in the clip", () => {
    const cuts = fillerCuts(input, "en");
    expect(cuts?.count).toBe(2);
    expect(cuts!.removedSec).toBeGreaterThan(0);
    expect(cleanupCutsDescription(cuts!, { one: "filler word", many: "filler words" }, "No filler words found")).toMatch(/^2 filler words, /);
  });

  test("a regional English tag uses the same list", () => {
    expect(fillerCuts(input, "en-GB")?.count).toBe(2);
  });

  test("languages without a built-in list leave the row out", () => {
    expect(fillerCuts(input, "ur")).toBeNull();
    expect(fillerCuts(input, "de")).toBeNull();
    expect(fillerCuts(input, null)).toBeNull();
  });

  test("hesitations already cut are not offered again", () => {
    const cuts = fillerCuts({ ...input, deletedRanges: fillerCuts(input, "en")!.ranges }, "en");
    expect(cuts).toEqual({ ranges: [], count: 0, removedSec: 0 });
  });

  test("a clip without hesitations says so", () => {
    const clean = [UTTERANCES[2]!];
    const cuts = fillerCuts({ ...input, utterances: clean }, "en");
    expect(cuts?.count).toBe(0);
    expect(cleanupCutsDescription(cuts!, { one: "filler word", many: "filler words" }, "No filler words found")).toBe("No filler words found");
  });
});

describe("Auto reframe row", () => {
  const defaults = studioEditsSchema.parse({});

  test("a new clip is already Auto", () => {
    expect(defaults.framing.mode).toBe("auto");
    expect(wholeClipIsAuto(defaults, "9:16", 30)).toBe(true);
  });

  test("a scene on another layout, a manual speaker move or a fitted background turn it off", () => {
    const split = sceneLayoutEdits(defaults, { aspectRatio: "9:16", scene: { startSec: 4, endSec: 10, speakerLayerCount: 2 }, applyToAllScenes: false, editedDurationSec: 30, choice: "side-by-side", id: "s1" });
    expect(wholeClipIsAuto(split, "9:16", 30)).toBe(false);
    const fitted = { ...defaults, background: { ...defaults.background, mode: "color" as const } };
    expect(wholeClipIsAuto(fitted, "9:16", 30)).toBe(false);
    const centered = { ...defaults, framing: { mode: "center" as const } };
    expect(wholeClipIsAuto(centered, "9:16", 30)).toBe(false);
    // Another aspect ratio's choices do not count.
    expect(wholeClipIsAuto(split, "1:1", 30)).toBe(true);
  });

  test("Apply sets the whole clip to Auto in one edit, dropping scene choices and speaker moves", () => {
    const centered = { ...defaults, framing: { mode: "center" as const } };
    const split = sceneLayoutEdits(centered, { aspectRatio: "9:16", scene: { startSec: 4, endSec: 10, speakerLayerCount: 2 }, applyToAllScenes: false, editedDurationSec: 30, choice: "side-by-side", id: "s1" });
    const applied = sceneLayoutEdits(split, { aspectRatio: "9:16", scene: null, applyToAllScenes: true, editedDurationSec: 30, choice: "auto", id: "all" });
    expect(applied.sceneLayouts.filter((selection) => selection.aspectRatio === "9:16")).toEqual([{ id: "all", aspectRatio: "9:16", startSec: 0, endSec: 30, preset: "auto" }]);
    expect(wholeClipIsAuto(applied, "9:16", 30)).toBe(true);
  });

  test("Auto selections with a gap fall back to the clip default there", () => {
    const centered = { ...defaults, framing: { mode: "center" as const } };
    const partial = sceneLayoutEdits(centered, { aspectRatio: "9:16", scene: { startSec: 0, endSec: 10, speakerLayerCount: 1 }, applyToAllScenes: false, editedDurationSec: 30, choice: "auto", id: "a" });
    expect(wholeClipIsAuto(partial, "9:16", 30)).toBe(false);
  });

  test("the speaker-analysis line", () => {
    expect(reframeNote("available")).toBeNull();
    expect(reframeNote("pending")).toMatch(/running/);
    expect(reframeNote("failed")).toMatch(/isn’t available/);
  });
});

describe("Add emojis row", () => {
  const base = { enabled: true, shown: 0, hasWords: true, run: { status: "idle" } as const };

  test("Apply while the clip has none", () => {
    expect(emojiRowView(base)).toEqual({ kind: "apply", description: "AI adds emojis that match what is said", busy: false });
  });

  test("progress shows inside the button while saving and running", () => {
    expect(emojiRowView({ ...base, run: { status: "saving", density: "balanced" } })).toEqual({ kind: "apply", description: "Saving your edits first", busy: true });
    expect(emojiRowView({ ...base, shown: 4, run: { status: "running", density: "balanced" } })).toMatchObject({ kind: "apply", busy: true });
  });

  test("emojis exist: the count, and the way to edit them", () => {
    expect(emojiRowView({ ...base, shown: 12 })).toEqual({ kind: "open", description: "12 emojis" });
    expect(emojiRowView({ ...base, shown: 1 })).toEqual({ kind: "open", description: "1 emoji" });
    expect(emojiRowView({ ...base, shown: 3, enabled: false })).toEqual({ kind: "open", description: "3 emojis, turned off" });
  });

  test("an empty answer says so and offers Apply again", () => {
    expect(emojiRowView({ ...base, run: { status: "done", added: 0, leftOut: 0, partial: false } })).toEqual({ kind: "apply", description: "No emojis fit this clip", busy: false });
  });

  test("no caption words: left out", () => {
    expect(emojiRowView({ ...base, hasWords: false })).toEqual({ kind: "hidden" });
  });
});

describe("Auto-censor row", () => {
  test("the free scan's count", () => {
    expect(censorRowDescription(3, 0)).toBe("3 words found");
    expect(censorRowDescription(1, 0)).toBe("1 word found");
    expect(censorRowDescription(2, 4)).toBe("2 words found, 4 censored");
    expect(censorRowDescription(0, 4)).toBe("4 censored");
    expect(censorRowDescription(0, 0)).toBe("No sensitive words found");
  });
});

describe("which rows show", () => {
  const row = (id: AiToolRowState["id"]): AiToolRowState => ({ id, icon: null, title: id, description: "", control: { kind: "none" } });

  test("panel order, whatever order the hooks return, and left-out rows are gone", () => {
    const rows = orderAiToolRows([row("broll"), null, row("censor"), row("emojis"), null, row("silences")]);
    expect(rows.map((shown) => shown.id)).toEqual(["emojis", "silences", "censor", "broll"]);
  });

  test("read-only: Apply is not offered, chevrons still open panels", () => {
    const onApply = () => undefined;
    const onOpen = () => undefined;
    expect(rowControl({ kind: "apply", onApply }, true)).toEqual({ kind: "none" });
    expect(rowControl({ kind: "apply", onApply }, false)).toEqual({ kind: "apply", onApply });
    expect(rowControl({ kind: "open", onOpen }, true)).toEqual({ kind: "open", onOpen });
  });
});
