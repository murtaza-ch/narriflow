import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Combo (`samples/templates/m54-combo.js`): not ported yet; it draws the placeholder line.
 */

export const COMBO_DEMO: DemoScript = {
  lines: [
    "listen:b up:b guys:b",
    "this:m one:b trick:b doubled:h@560 my:m views:b",
    "in:m just:b ten:b days:b",
    "your:m+850 turn:h@520",
    "go:b crush:b it:b",
  ],
  options: { rate: 240, gap: 20, cueGap: 90, tail: 700 },
};

export const comboProgram: SceneProgram = placeholderProgram;
