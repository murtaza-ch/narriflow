import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Slice (`samples/templates/m11-slice.js`): not ported yet; it draws the placeholder line.
 */

export const SLICE_DEMO: DemoScript = {
  lines: [
    "nobody:b is:m coming:b to:m save:b you:b",
    "build:b it:m yourself:h@560",
    "start:b ugly:h@520",
    "fix:b it:m in:m public:b",
    "just:m keep:b shipping:h@600",
  ],
  options: { rate: 300, cueGap: 160, tail: 700 },
};

export const sliceProgram: SceneProgram = placeholderProgram;
