import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Splat (`samples/templates/m79-splat.js`): not ported yet; it draws the placeholder line.
 */

export const SPLAT_DEMO: DemoScript = {
  lines: [
    "wait:b this:m is:m insane:h@520",
    "no:b way:b",
    "game:b day:h@520",
    "absolutely:b not:m panic:b",
    "very:b nice:h@480",
    "incredible:h@600",
  ],
  options: { rate: 215, gap: 30, cueGap: 140, tail: 420, lead: 250 },
};

export const splatProgram: SceneProgram = placeholderProgram;
