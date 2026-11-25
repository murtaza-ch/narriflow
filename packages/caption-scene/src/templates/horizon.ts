import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Horizon (`samples/templates/m74-synthwave.js`): not ported yet; it draws the placeholder line.
 */

export const HORIZON_DEMO: DemoScript = {
  lines: [
    "future:h@1100 is:m loading:b",
    "no:b brakes:b no:b limits:b no:b regrets",
    "neon:h@1000 nights:b",
    "press:b start:h@1000",
    "game:b on:m",
  ],
  options: { rate: 245, gap: 30, cueGap: 170, tail: 800, lead: 350 },
};

export const horizonProgram: SceneProgram = placeholderProgram;
