import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Trail (`samples/templates/m17-trail.js`): not ported yet; it draws the placeholder line.
 */

export const TRAIL_DEMO: DemoScript = {
  lines: [
    "so:m I:m tried:b this:b trick",
    "and:m it:m actually:b worked:h@600",
    "my:m sales:b doubled",
    "in:m one:b week:h@620",
    "no:m joke",
  ],
  options: { rate: 280, cueGap: 150, tail: 780 },
};

export const trailProgram: SceneProgram = placeholderProgram;
