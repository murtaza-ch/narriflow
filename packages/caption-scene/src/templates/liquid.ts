import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Liquid (`samples/templates/m60-glass.js`) (the sample's "Glass"; a classic preset already owns that name): not ported yet; it draws the placeholder line.
 */

export const LIQUID_DEMO: DemoScript = {
  lines: [
    "the:m new:b update:b feels:b like:m glass:h@600",
    "every:b edge:b catches:b light:b",
    "simple:h@600",
    "nothing:b extra:h@540",
    "just:m clear:b",
  ],
  options: { rate: 245, cueGap: 150, lead: 380, tail: 700, gap: 30 },
};

export const liquidProgram: SceneProgram = placeholderProgram;
