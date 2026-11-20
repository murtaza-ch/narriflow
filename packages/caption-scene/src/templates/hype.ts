import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Hype (`samples/templates/m08-sticker.js`): not ported yet; it draws the placeholder line.
 */

export const HYPE_DEMO: DemoScript = {
  lines: [
    "okay:b this:m is:m huge:h@560",
    "we:m just:b hit 10K:h@620",
    "subscribers",
    "thank:b you:m so:m much",
    "for:m real:h@600",
  ],
  options: { rate: 280, cueGap: 150, tail: 820 },
};

export const hypeProgram: SceneProgram = placeholderProgram;
