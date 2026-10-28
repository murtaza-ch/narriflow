import { describe, expect, test } from "bun:test";
import { CAPTION_PRESETS, captionPresetSchema } from "@narriflow/validators";
import { transcriptHighlight } from "./transcript-highlight";

const preset = (id: string) => CAPTION_PRESETS.find((entry) => entry.id === id)!.preset;

describe("transcriptHighlight", () => {
  test("a coloured highlight colours the word", () => {
    expect(transcriptHighlight(preset("bold-pop"))).toEqual({ color: "#FFE11A", pill: null });
  });

  test("a pill style keeps its pill and its text colour", () => {
    expect(transcriptHighlight(preset("spotlight"))).toEqual({
      color: "#FFFFFF",
      pill: "rgba(108, 77, 255, 1)",
    });
  });

  test("a white highlight takes the colour of the style's other words", () => {
    expect(transcriptHighlight(preset("street"))).toEqual({ color: "#AAFF00", pill: null });
  });

  test("an all-white style with no pill falls back to the Studio accent", () => {
    expect(transcriptHighlight(preset("punch"))).toBeNull();
    expect(transcriptHighlight(captionPresetSchema.parse({ highlightColor: "#EEEEEE" }))).toBeNull();
  });

  test("a highlight too dark for the transcript panel falls back to the Studio accent", () => {
    expect(transcriptHighlight(captionPresetSchema.parse({ highlightColor: "#111111", primaryColor: "#FFFFFF" }))).toBeNull();
    expect(
      transcriptHighlight(captionPresetSchema.parse({ highlightColor: "#FFFFFF", highlightBoxColor: "#050505" })),
    ).toBeNull();
  });
});
