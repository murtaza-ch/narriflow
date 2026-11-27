import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Helium (`samples/templates/m82-helium.js`): not ported yet; it draws the placeholder line.
 */

export const HELIUM_DEMO: DemoScript = {
  lines: [
    "just:b let:b it:m go:b",
    "your:m ideas:b deserve:b to:m FLY:h@580",
    "UNSTOPPABLE:h@900",
    "you:m are:b lighter:b than:m you:m think:b",
    "keep:b RISING:h@640",
  ],
  options: { rate: 220, gap: 30, cueGap: 250, tail: 380, lead: 170 },
};

export const heliumProgram: SceneProgram = placeholderProgram;
