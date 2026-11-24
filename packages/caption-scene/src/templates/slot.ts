import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Slot (`samples/templates/m32-slot.js`): not ported yet; it draws the placeholder line.
 */

export const SLOT_DEMO: DemoScript = {
  lines: [
    "this:m trick:b saves:b you:m hours:h@540",
    "every:m single:b week",
    "stop:b doing:b it:m manually:h@560",
    "just:m automate:h@600 it:m",
    "and:m go:b outside",
  ],
  options: { rate: 255, cueGap: 130 },
};

export const slotProgram: SceneProgram = placeholderProgram;
