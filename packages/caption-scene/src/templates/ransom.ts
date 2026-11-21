import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Ransom (`samples/templates/m18-collage.js`): not ported yet; it draws the placeholder line.
 */

export const RANSOM_DEMO: DemoScript = {
  lines: [
    "taste is:m a:m skill:h@600",
    "nobody:b is:m born:b with:m it",
    "copy:b what:m you:m love:h@560",
    "then:m make:b it yours:h@620",
  ],
  options: { rate: 285, cueGap: 160, tail: 900 },
};

export const ransomProgram: SceneProgram = placeholderProgram;
