import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Keycap (`samples/templates/m78-keycap.js`): not ported yet; it draws the placeholder line.
 */

export const KEYCAP_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m motivation:b",
    "it:m starts:b when:m you:m press:h@480",
    "small:b steps:b every:b day",
    "consistency:h@760 beats:b talent:b",
    "one:m key:b at:m a:m time",
    "now:h@520",
  ],
  options: { rate: 245, cueGap: 150, tail: 520, lead: 70 },
};

export const keycapProgram: SceneProgram = placeholderProgram;
