import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Blinds (`samples/templates/m59-blinds.js`): not ported yet; it draws the placeholder line.
 */

export const BLINDS_DEMO: DemoScript = {
  lines: [
    "nobody:b cares:b about:b your:m excuses:h@560",
    "they:m care:b about:m results:h@580",
    "so:m stop:b talking:b",
    "start:b doing:h@500",
    "now:b@560",
  ],
  options: { rate: 245, cueGap: 160, lead: 380, tail: 720, gap: 30 },
};

export const blindsProgram: SceneProgram = placeholderProgram;
