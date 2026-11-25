import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Marquee (`samples/templates/m73-vintage.js`): not ported yet; it draws the placeholder line.
 */

export const MARQUEE_DEMO: DemoScript = {
  lines: [
    "the:m good:b old:b days:h@1000",
    "they:m don't:m make:b them:m like:b this:b",
    "legends:h@1050",
    "built:b to:m last:b forever:h@1100",
    "see:b you:m next:b time:b",
  ],
  options: { rate: 245, gap: 30, cueGap: 170, tail: 800, lead: 350 },
};

export const marqueeProgram: SceneProgram = placeholderProgram;
