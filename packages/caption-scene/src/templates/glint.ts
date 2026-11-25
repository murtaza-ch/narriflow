import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Glint (`samples/templates/m72-glint.js`): not ported yet; it draws the placeholder line.
 */

export const GLINT_DEMO: DemoScript = {
  lines: [
    "stop:b scrolling:b and:m LISTEN:h@520",
    "nobody:b tells:b you:m THIS:h@460",
    "it's:m free:b and:m easy:b",
    "just:b start:b TODAY:h@520",
    "make:b it:m HAPPEN:h@560",
  ],
  options: { rate: 225, gap: 45, cueGap: 160, tail: 640, lead: 340 },
};

export const glintProgram: SceneProgram = placeholderProgram;
