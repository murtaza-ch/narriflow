import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Googly (`samples/templates/m27-googly.js`): not ported yet; it draws the placeholder line.
 */

export const GOOGLY_DEMO: DemoScript = {
  lines: [
    "my:m cat:h@480 runs:b my:m life:b",
    "she:b wakes:b me:m at:m five:h@460",
    "every:b single:b day:b",
    "help:h@480 i'm:m stuck:b",
    "and:m i'd:m do:b it:m again:h@520",
  ],
  options: { rate: 225, gap: 30, cueGap: 240, tail: 600, lead: 300 },
};

export const googlyProgram: SceneProgram = placeholderProgram;
