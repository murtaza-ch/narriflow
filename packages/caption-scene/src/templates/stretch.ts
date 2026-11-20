import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Stretch (`samples/templates/m07-stretch.js`): not ported yet; it draws the placeholder line.
 */

export const STRETCH_DEMO: DemoScript = {
  lines: [
    "I:m spent:b three:b years:b being:m QUIET:h@560",
    "posting:b nothing:b+60",
    "then:m one:b video:b went:b VIRAL:h@560",
    "so:m here's:m my:m advice:b",
    "just:m START:h@600",
  ],
  options: { rate: 255, cueGap: 170, tail: 700 },
};

export const stretchProgram: SceneProgram = placeholderProgram;
