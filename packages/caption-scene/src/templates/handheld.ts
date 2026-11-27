import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Handheld (`samples/templates/m81-handheld.js`): not ported yet; it draws the placeholder line.
 */

export const HANDHELD_DEMO: DemoScript = {
  lines: [
    "you:m only:b get:b one:m life:h@520",
    "so:m stop:b waiting:b",
    "press:b start:h@560",
    "it's:m not:b that:m hard:b",
    "level:h@540 up:b today:b",
    "become:b a:m legend:h@640",
  ],
  options: { rate: 205, gap: 30, cueGap: 330, tail: 300, lead: 240 },
};

export const handheldProgram: SceneProgram = placeholderProgram;
