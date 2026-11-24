import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Shuffle (`samples/templates/m22-unscramble.js`): not ported yet; it draws the placeholder line.
 */

export const SHUFFLE_DEMO: DemoScript = {
  lines: [
    "okay:m this:b took:b me:m years:h@600",
    "to:m figure:b out",
    "the:m secret:b is:m boring:h@620",
    "seriously",
    "just:m show:b up:b daily:h@600",
  ],
  options: { rate: 290, cueGap: 160, tail: 750 },
};

export const shuffleProgram: SceneProgram = placeholderProgram;
