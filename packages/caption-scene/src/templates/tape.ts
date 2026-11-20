import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Tape (`samples/templates/m05-tape.js`): not ported yet; it draws the placeholder line.
 */

export const TAPE_DEMO: DemoScript = {
  lines: [
    "nobody:b is:m coming:b to:m save:b you",
    "your:m career:h@620",
    "is:m on:m you",
    "so:m ship:h@560",
    "every:b single:b week",
  ],
  options: { rate: 270, cueGap: 160, tail: 760 },
};

export const tapeProgram: SceneProgram = placeholderProgram;
