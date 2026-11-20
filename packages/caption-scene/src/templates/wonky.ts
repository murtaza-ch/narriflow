import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Wonky (`samples/templates/m01-wonky.js`): not ported yet; it draws the placeholder line.
 */

export const WONKY_DEMO: DemoScript = {
  lines: [
    "nobody cares:h@560 at:m first",
    "so:m keep posting",
    "the:m first:b hundred:h@600 are:m practice",
    "then:b it:m clicks:h@560",
    "promise:h@620+420",
  ],
  options: { rate: 270, cueGap: 150, tail: 760 },
};

export const wonkyProgram: SceneProgram = placeholderProgram;
