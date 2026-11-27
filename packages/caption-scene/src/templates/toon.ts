import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Toon (`samples/templates/m85-toon.js`): not ported yet; it draws the placeholder line.
 */

export const TOON_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m a:m perfect:h@560 moment:b",
    "just:b start:h@520",
    "nobody:b is:m watching:b you:b that:m closely:b",
    "consistency:h@720 wins:b",
    "it:m only:b takes a:m spark:h@520",
  ],
  options: { rate: 200, gap: 30, cueGap: 330, tail: 420, lead: 260 },
};

export const toonProgram: SceneProgram = placeholderProgram;
