import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Aura (`samples/templates/44-aura.js`): not ported yet; it draws the placeholder line.
 */

export const AURA_DEMO: DemoScript = {
  lines: [
    "you:m don't:b have:b to:m rush",
    "healing:b takes:b time:h@720",
    "be:m gentle:h@740 with:m yourself:b",
    "just:b breathe:h@820",
  ],
  options: { rate: 340, gap: 40, cueGap: 300, lead: 450, tail: 900 },
};

export const auraProgram: SceneProgram = placeholderProgram;
