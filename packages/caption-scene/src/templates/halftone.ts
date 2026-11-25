import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Halftone (`samples/templates/m75-halftone.js`): not ported yet; it draws the placeholder line.
 */

export const HALFTONE_DEMO: DemoScript = {
  lines: [
    "keep:b it:m GROOVY:h@640",
    "good:b vibes:b ONLY:h@560",
    "slow:b down:b and:m smell:b the:m roses:b",
    "peace:b love:b SUNSHINE:h@680",
    "stay:b GOLDEN:h@640",
  ],
  options: { rate: 235, gap: 50, cueGap: 170, tail: 720, lead: 340 },
};

export const halftoneProgram: SceneProgram = placeholderProgram;
