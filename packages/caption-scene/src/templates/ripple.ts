import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Ripple (`samples/templates/m62-ripple.js`): not ported yet; it draws the placeholder line.
 */

export const RIPPLE_DEMO: DemoScript = {
  lines: [
    "feel:b the:m wave:h@600",
    "it:m+450 carries:b you:b",
    "every:b little:b thing:b is:m gonna:m be:m alright:h@760",
    "just:m+450 breathe:b",
    "and:m let:b it:m flow:h@620",
  ],
  options: { rate: 275, cueGap: 150, tail: 820, lead: 380 },
};

export const rippleProgram: SceneProgram = placeholderProgram;
