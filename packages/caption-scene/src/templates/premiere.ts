import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Premiere (`samples/templates/m04-poster.js`): not ported yet; it draws the placeholder line.
 */

export const PREMIERE_DEMO: DemoScript = {
  lines: [
    "Nobody:b tells:b you:m this",
    "quiet:h@600 years:b matter:b most:b",
    "that's:m where:b it:m all:m gets:b built",
    "so:m keep:b going:h@640",
  ],
  options: { rate: 290, cueGap: 160, tail: 800, lead: 350 },
};

export const premiereProgram: SceneProgram = placeholderProgram;
