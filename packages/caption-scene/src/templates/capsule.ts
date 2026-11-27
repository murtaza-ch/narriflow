import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Capsule (`samples/templates/m83-capsule.js`): not ported yet; it draws the placeholder line.
 */

export const CAPSULE_DEMO: DemoScript = {
  lines: [
    "nobody:b is:m coming:b",
    "so:m build:b it:m now:h@480",
    "start:b before:b you:m feel:m ready:h@520",
    "today:h@560",
    "not:m someday:b",
    "the:m work:b gets:b easier:h@560",
  ],
  options: { rate: 175, gap: 20, cueGap: 540, tail: 520, lead: 260 },
};

export const capsuleProgram: SceneProgram = placeholderProgram;
