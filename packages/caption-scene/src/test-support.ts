import type { SceneCue, SceneInput } from "./input";
import type { Measure } from "./scene";

/** A deterministic stand-in for a renderer's measurement: 0.55 em per character, ink 0.72 em up and 0.2 em down. */
export const fakeMeasure: Measure = (text, _face, sizePx, letterSpacingEm) => ({
  advance: [...text].length * (0.55 + letterSpacingEm) * sizePx - letterSpacingEm * sizePx,
  inkTop: -0.72 * sizePx,
  inkBottom: 0.2 * sizePx,
  ascent: 1.1 * sizePx,
  descent: 0.3 * sizePx,
});

export function sceneInput(cues: readonly SceneCue[], overrides: Partial<SceneInput> = {}): SceneInput {
  return {
    cues,
    canvas: { width: 1080, height: 1920 },
    anchor: { xPct: 50, yPct: (1300 / 1920) * 100 },
    colours: { primary: "#FFFFFF", highlight: "#FFE9A8", accent: "#FFFFFF", shadow: "#000000" },
    scale: 1,
    measure: fakeMeasure,
    ...overrides,
  };
}
