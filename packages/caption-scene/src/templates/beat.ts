import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Beat (`samples/templates/m06-beat.js`): not ported yet; it draws the placeholder line.
 */

export const BEAT_DEMO: DemoScript = {
  lines: [
    "talent:b gets:b you:m noticed:h@560",
    "habits:b keep:b you:m there",
    "show:b up",
    "anyway:h@600",
    "that's:m the:m whole:b secret:h@600",
  ],
  options: { rate: 280, cueGap: 150, tail: 760 },
};

export const beatProgram: SceneProgram = placeholderProgram;
