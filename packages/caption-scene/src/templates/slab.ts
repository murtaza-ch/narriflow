import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Slab (`samples/templates/m25-slab.js`): not ported yet; it draws the placeholder line.
 */

export const SLAB_DEMO: DemoScript = {
  lines: [
    "most:b people:b quit:b right:m before:b it:m works:h@520",
    "nobody:b is:m watching:b",
    "so:m start:b ugly:h@480",
    "post:b it:m before:m you're:m ready:h@500",
    "every:b expert was:m once:m a:m beginner:h@560",
  ],
  options: { rate: 205, gap: 25, cueGap: 200, tail: 560, lead: 300 },
};

export const slabProgram: SceneProgram = placeholderProgram;
