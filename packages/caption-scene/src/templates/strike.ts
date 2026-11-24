import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Strike (`samples/templates/m29-strike.js`): not ported yet; it draws the placeholder line.
 */

export const STRIKE_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m motivation:h@560",
    "it:m doesn't:b show:b up:m first",
    "you:m never:b feel:b ready:h@540",
    "so:m start:h@520 anyway",
    "it's:m not:b about:m perfect:h@520",
    "keep:b going:b",
  ],
  options: { rate: 255, cueGap: 120 },
};

export const strikeProgram: SceneProgram = placeholderProgram;
