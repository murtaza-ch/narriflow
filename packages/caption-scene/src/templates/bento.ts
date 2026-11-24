import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Bento (`samples/templates/m61-bento.js`): not ported yet; it draws the placeholder line.
 */

export const BENTO_DEMO: DemoScript = {
  lines: [
    "stop:b scrolling:b start:b building:h@620",
    "most:m people:b quit:b right:m before:m it:m works:h@600",
    "just:m keep:b going:b",
    "small:b habits:b big:b results:h@620",
    "that's:m the:m whole:b secret:h@620",
  ],
  options: { rate: 255, cueGap: 150, tail: 800, lead: 380 },
};

export const bentoProgram: SceneProgram = placeholderProgram;
