import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Rainbow (the sample's "Rainbow3D") (`samples/templates/m67-rainbow3d.js`): not ported yet; it draws the placeholder line.
 */

export const RAINBOW_DEMO: DemoScript = {
  lines: [
    "start:b before you're:m ready:h@600",
    "small:b wins add:m up:h@520",
    "keep:b it:m simple:b",
    "post:b it:m today:h@560",
    "have:b fun:b",
  ],
  options: { rate: 215, gap: 40, cueGap: 200, tail: 660, lead: 320 },
};

export const rainbowProgram: SceneProgram = placeholderProgram;
