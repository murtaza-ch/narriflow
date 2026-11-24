import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Broadway (`samples/templates/m63-broadway.js`): not ported yet; it draws the placeholder line.
 */

export const BROADWAY_DEMO: DemoScript = {
  lines: [
    "ladies:b and:m gentlemen:b",
    "your:m time:b to:m shine:h@700",
    "no:b second:b takes:b",
    "lights:b camera:b action:h@660",
    "take:b a:m bow:h@640",
  ],
  options: { rate: 285, cueGap: 150, tail: 820, lead: 380 },
};

export const broadwayProgram: SceneProgram = placeholderProgram;
