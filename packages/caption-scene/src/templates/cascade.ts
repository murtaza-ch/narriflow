import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Cascade (`samples/templates/m20-mechanica.js`): not ported yet; it draws the placeholder line.
 */

export const CASCADE_DEMO: DemoScript = {
  lines: [
    "you:m don't:b need:b more:b time",
    "you:m need:b",
    "FOCUS:h@620",
    "cut:b+520 the:m noise:b and",
    "SHIP:h@620",
  ],
  options: { rate: 265, cueGap: 200, tail: 900 },
};

export const cascadeProgram: SceneProgram = placeholderProgram;
