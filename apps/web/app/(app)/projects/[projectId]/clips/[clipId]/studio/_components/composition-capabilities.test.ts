import { describe, expect, test } from "bun:test";
import { parseCompositionCapabilities } from "./composition-capabilities";

describe("composition plan web capabilities", () => {
  test("keeps only analysis kill switches", () => {
    expect(parseCompositionCapabilities({})).toEqual({
      automaticSpeakerLayoutEnabled: true,
      explicitSplitLayoutEnabled: true,
      screenLayoutEnabled: true,
    });
    expect(
      parseCompositionCapabilities({
        NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT: "0",
        NEXT_PUBLIC_SPLIT_LAYOUT: "0",
        NEXT_PUBLIC_SCREEN_LAYOUT: "0",
      }),
    ).toEqual({
      automaticSpeakerLayoutEnabled: false,
      explicitSplitLayoutEnabled: false,
      screenLayoutEnabled: false,
    });
    expect(() =>
      parseCompositionCapabilities({
        NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT: "disabled",
      }),
    ).toThrow("NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT");
    expect(() =>
      parseCompositionCapabilities({
        NEXT_PUBLIC_SPLIT_LAYOUT: "disabled",
      }),
    ).toThrow("NEXT_PUBLIC_SPLIT_LAYOUT");
    expect(() =>
      parseCompositionCapabilities({
        NEXT_PUBLIC_SCREEN_LAYOUT: "disabled",
      }),
    ).toThrow("NEXT_PUBLIC_SCREEN_LAYOUT");
  });
});
