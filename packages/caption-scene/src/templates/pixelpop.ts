import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Pixelpop (`samples/templates/m70-pixelpop.js`): not ported yet; it draws the placeholder line.
 */

export const PIXELPOP_DEMO: DemoScript = {
  lines: [
    "level:b up:b skills:h@640",
    "press:b start:h@560",
    "just:b hit:b record:b",
    "you:m got:m this:h@520",
    "new:b high:b score:h@600",
  ],
  options: { rate: 205, gap: 40, cueGap: 200, tail: 680, lead: 320 },
};

export const pixelpopProgram: SceneProgram = placeholderProgram;
