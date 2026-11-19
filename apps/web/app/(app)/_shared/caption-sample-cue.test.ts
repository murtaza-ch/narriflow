import { describe, expect, test } from "bun:test";
import { CAPTION_PRESETS, captionPresetSchema, getCaptionPresetById } from "@narriflow/validators";
import { CAPTION_SAMPLE_WORDS, captionSampleBlockCue } from "./caption-sample-cue";

describe("captionSampleBlockCue", () => {
  test("a classic preset has no block sample", () => {
    expect(captionSampleBlockCue(getCaptionPresetById("bold-pop")!.preset, { xPct: 50, yPct: 60 })).toBeNull();
  });

  test("Headline's sample is a real block with a hero, built by the plan's builder", () => {
    const cue = captionSampleBlockCue(getCaptionPresetById("headline")!.preset, { xPct: 50, yPct: 60 })!;
    expect(cue.block.style).toBe("headline");
    expect(cue.block.texts).toEqual(CAPTION_SAMPLE_WORDS.map((word) => word.text));
    expect(cue.block.roles).toContain("hero");
    // The hero sits alone on its row in the stack.
    const heroRow = cue.block.rows.find((row) => row.every((index) => cue.block.roles[index] === "hero"));
    expect(heroRow).toBeDefined();
    expect(cue.words.map((word) => word.startSec)).toEqual(CAPTION_SAMPLE_WORDS.map((word) => word.startSec));
    expect(cue.activeRange.endSec).toBeGreaterThan(CAPTION_SAMPLE_WORDS.at(-1)!.endSec);
  });

  test("every Dynamic preset samples its own style; only Cutout, which draws no hero, keeps none", () => {
    for (const named of CAPTION_PRESETS.filter((candidate) => candidate.group === "Dynamic")) {
      const cue = captionSampleBlockCue(named.preset, { xPct: 50, yPct: 60 })!;
      expect(cue.block.style).toBe(named.preset.dynamic!);
      expect(cue.block.roles.includes("hero")).toBe(named.id !== "cutout");
    }
    const cutout = captionSampleBlockCue(getCaptionPresetById("cutout")!.preset, { xPct: 50, yPct: 60 })!;
    expect(cutout.block.texts).toEqual(["MAKE", "IT", "POP"]);
    expect(cutout.block.rows).toEqual([[0, 1, 2]]);
  });

  test("a dynamic preset showing two words samples the last two", () => {
    const preset = captionPresetSchema.parse({ ...getCaptionPresetById("headline")!.preset, wordsPerCue: 1 });
    const cue = captionSampleBlockCue(preset, { xPct: 50, yPct: 60 })!;
    expect(cue.block.texts).toEqual(["it", "pop"]);
    expect(cue.block.roles).toContain("hero");
  });
});
