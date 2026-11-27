import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Pen Tool (`samples/templates/m84-pentool.js`): not ported yet; it draws the placeholder line.
 */

export const PENTOOL_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m motivation:h@520",
    "talent:b is:m overrated:b",
    "do:b the:m boring:h@460 things:b every:b day:b",
    "trust:b the:m process:h@460",
    "beat:b procrastination:h@640 today:b",
    "no:b excuses:b",
  ],
  options: { rate: 200, gap: 26, cueGap: 110, tail: 480, lead: 330 },
};

export const pentoolProgram: SceneProgram = placeholderProgram;
