import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Thermal (`samples/templates/m31-thermal.js`): not ported yet; it draws the placeholder line.
 */

export const THERMAL_DEMO: DemoScript = {
  lines: [
    "turn:b up:m the:m heat:h@520",
    "stay:b cool:b under:m pressure",
    "the:m best:b ideas:b come:b at:m night:h@560",
    "burn:b brighter:h@560",
    "don't:b cool:b down",
  ],
  options: { rate: 270, cueGap: 140 },
};

export const thermalProgram: SceneProgram = placeholderProgram;
