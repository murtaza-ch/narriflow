import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Heft (`samples/templates/m14-weight.js`): not ported yet; it draws the placeholder line.
 */

export const HEFT_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m permission",
    "just:b build:h@560",
    "make:b+380 it:m ugly:b first",
    "then:b make:b it:m yours:h@600",
  ],
  options: { rate: 290, cueGap: 160, tail: 850, lead: 350 },
};

export const heftProgram: SceneProgram = placeholderProgram;
