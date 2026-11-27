import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Sketch (`samples/templates/m80-sketch.js`): not ported yet; it draws the placeholder line.
 */

export const SKETCH_DEMO: DemoScript = {
  lines: [
    "most:b people:b never:m start:b",
    "start:b before:b you're:m ready:h@560",
    "courage:h@600 is:m quiet:b",
    "you:m are:b unstoppable:h@720",
    "keep:b going:h@520",
  ],
  options: { rate: 205, gap: 30, cueGap: 240, tail: 200, lead: 300 },
};

export const sketchProgram: SceneProgram = placeholderProgram;
