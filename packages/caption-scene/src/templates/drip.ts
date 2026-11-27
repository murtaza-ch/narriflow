import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Drip (`samples/templates/m86-drip.js`): not ported yet; it draws the placeholder line.
 */

export const DRIP_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m permission:h@660",
    "nobody:b is:m coming:b to:m save:b you:b",
    "just:m start:h@600 now:b",
    "keep:b showing:b up:m consistency:h@680",
    "you:m got:b this:b",
  ],
  options: { rate: 135, gap: 25, cueGap: 600, tail: 420, lead: 200 },
};

export const dripProgram: SceneProgram = placeholderProgram;
