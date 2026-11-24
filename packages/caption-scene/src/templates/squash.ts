import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Squash (`samples/templates/m24-squash.js`): not ported yet; it draws the placeholder line.
 */

export const SQUASH_DEMO: DemoScript = {
  lines: [
    "most:m people never:b START:h@560",
    "they're:m waiting:b for the:m perfect:b MOMENT:h@600",
    "it:m won't:b come:b@420",
    "so:m build:b it YOURSELF:h@640",
  ],
  options: { rate: 265, cueGap: 170, tail: 720 },
};

export const squashProgram: SceneProgram = placeholderProgram;
