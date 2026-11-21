import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Ledge (`samples/templates/m19-dropbar.js`): not ported yet; it draws the placeholder line.
 */

export const LEDGE_DEMO: DemoScript = {
  lines: [
    "okay:b real:b talk",
    "i:m quit:b my:m job:h@520",
    "with:m zero:b savings:h@620",
    "and:m honestly",
    "best:b call:b ever:h@560",
  ],
  options: { rate: 300, cueGap: 170, tail: 750 },
};

export const ledgeProgram: SceneProgram = placeholderProgram;
