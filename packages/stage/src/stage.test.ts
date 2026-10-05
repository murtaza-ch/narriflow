import { describe, expect, test } from "bun:test";
import { CAPTION_PRESETS, DEFAULT_CAPTION_WORDS_PER_CUE } from "@narriflow/validators";
import { FEATURES, SCRIPT, buildScript, captionStyleFromPreset, cueAt, formatWord, PRESETS } from "./index";

describe("recovered marketing stage", () => {
  test("all gallery compositions have finite, looping storyboard clocks", () => {
    expect(FEATURES.map(({ id }) => id)).toEqual([
      "moments", "captions", "ratios", "reframe", "repurpose", "publish",
    ]);
    for (const composition of FEATURES) {
      expect(composition.duration).toBe(SCRIPT.duration);
      expect(composition.width).toBeGreaterThan(0);
      expect(composition.height).toBeGreaterThan(0);
    }
    expect(SCRIPT.words.at(-1)!.end).toBeLessThan(SCRIPT.duration);
    expect(cueAt(SCRIPT.duration)).toBeNull();
  });

  test("storyboards and playground use the current product caption presets", () => {
    for (const named of CAPTION_PRESETS) {
      const style = captionStyleFromPreset(named);
      expect(style.primary).toBe(named.preset.primaryColor);
      expect(style.highlight).toBe(named.preset.highlightColor);
      expect(style.outline).toBe(named.preset.outlineColor);
      expect(style.outlineWidth).toBe(named.preset.outlineWidth);
      expect(style.punctuation).toBe(named.preset.punctuation !== false);
    }
    expect(PRESETS.highlighter.font).toBe("Roboto");
    expect(PRESETS.boldPop.font).toBe("Montserrat");
    expect(PRESETS.boldPop.weight).toBe(900);
    expect(PRESETS.neon).toEqual(captionStyleFromPreset(CAPTION_PRESETS.find(({ id }) => id === "neon")!));
    expect(PRESETS.cinema).toEqual(captionStyleFromPreset(CAPTION_PRESETS.find(({ id }) => id === "cinema")!));
  });

  test("caption cues respect the shared chunk size and speaker boundaries", () => {
    const script = buildScript([
      { speaker: 0, text: "one two three four five six seven" },
      { speaker: 1, text: "eight nine ten" },
    ]);
    expect(script.cues.flatMap(({ words }) => words)).toEqual(script.words);
    for (const cue of script.cues) {
      expect(cue.words.length).toBeLessThanOrEqual(DEFAULT_CAPTION_WORDS_PER_CUE);
      expect(cue.words.every(({ speaker }) => speaker === cue.speaker)).toBe(true);
    }
    const secondSpeaker = script.cues.find(({ speaker }) => speaker === 1)!;
    expect(cueAt(secondSpeaker.start, script)?.cue.speaker).toBe(1);
  });

  test("punctuation does not split canonical cues or extend their export clock", () => {
    const script = buildScript([{ speaker: 0, text: "one, two three four" }]);
    expect(script.cues.map(cue => cue.words.map(word => word.text))).toEqual([["one,", "two", "three"], ["four"]]);
    const first = script.cues[0]!;
    expect(cueAt(first.start, script)?.cue).toBe(first);
    expect(cueAt(first.end, script)).toBeNull();
    expect(cueAt(script.cues[1]!.end, script)).toBeNull();
  });

  test("caption punctuation preserves apostrophes and hyphenated words", () => {
    expect(formatWord("Don't,", "uppercase", false)).toBe("DON'T");
    expect(formatWord("state-of-the-art.", "none", false)).toBe("state-of-the-art");
    expect(formatWord("Don't,", "uppercase")).toBe("DON'T,");
    const named = CAPTION_PRESETS[0]!;
    expect(captionStyleFromPreset({ ...named, preset: { ...named.preset, punctuation: false } }).punctuation).toBe(false);
  });
});
