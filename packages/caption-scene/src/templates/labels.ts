import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Labels (`samples/templates/m26-labels.js`): not ported yet; it draws the placeholder line.
 */

export const LABELS_DEMO: DemoScript = {
  lines: [
    "i:b quit:b my:m job:h@440",
    "best:b decision:b ever:b",
    "it:m was:m scary:h@520",
    "but:m staying:b was:m scarier:h@560",
    "bet:b on:m yourself:h@560",
  ],
  options: { rate: 215, gap: 35, cueGap: 230, tail: 560, lead: 300 },
};

export const labelsProgram: SceneProgram = placeholderProgram;
