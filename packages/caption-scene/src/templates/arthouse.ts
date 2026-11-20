import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Arthouse (`samples/templates/m13-cinema.js`): not ported yet; it draws the placeholder line.
 */

export const ARTHOUSE_DEMO: DemoScript = {
  lines: [
    "Here's:b what:m nobody:b warns:b you",
    "the:m first:b year:b is:m chaos:h@600",
    "do:b it:m anyway",
    "you'll:m thank:b yourself:h@640",
  ],
  options: { rate: 290, cueGap: 160, tail: 850, lead: 350 },
};

export const arthouseProgram: SceneProgram = placeholderProgram;
