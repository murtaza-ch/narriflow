import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Vibes (`samples/templates/m69-vibes.js`): not ported yet; it draws the placeholder line.
 */

export const VIBES_DEMO: DemoScript = {
  lines: [
    "you:b are:m ENOUGH:h@640 right:b now:b",
    "good:b VIBES:h@620 only:b",
    "be:m KIND:h@560",
    "take:b a:m deep:b breath:b",
    "stay:b WEIRD:h@620 and:m shine:b",
  ],
  options: { rate: 230, gap: 50, cueGap: 170, tail: 700, lead: 360 },
};

export const vibesProgram: SceneProgram = placeholderProgram;
