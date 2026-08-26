import { describe, expect, test } from "bun:test";
import { parseCompositionPlanControl } from "./composition-plan-control";

describe("composition plan web controls", () => {
  test("defaults each migrated mode to shadow and validates explicit cutover modes", () => {
    expect(parseCompositionPlanControl({})).toEqual({
      center: "shadow",
      fit: "shadow",
      auto: "shadow",
      automaticSpeakerLayoutEnabled: true,
    });
    expect(
      parseCompositionPlanControl({
        NEXT_PUBLIC_COMPOSITION_CENTER: "legacy",
        NEXT_PUBLIC_COMPOSITION_FIT: "shadow",
        NEXT_PUBLIC_COMPOSITION_AUTO: "plan",
      }),
    ).toEqual({
      center: "legacy",
      fit: "shadow",
      auto: "plan",
      automaticSpeakerLayoutEnabled: true,
    });
    expect(
      parseCompositionPlanControl({
        NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT: "0",
      }).automaticSpeakerLayoutEnabled,
    ).toBe(false);
    expect(() =>
      parseCompositionPlanControl({ NEXT_PUBLIC_COMPOSITION_CENTER: "on" }),
    ).toThrow("NEXT_PUBLIC_COMPOSITION_CENTER");
    expect(() =>
      parseCompositionPlanControl({
        NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT: "disabled",
      }),
    ).toThrow("NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT");
  });
});
