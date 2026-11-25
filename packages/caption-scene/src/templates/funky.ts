import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Funky (`samples/templates/m71-funky.js`): not ported yet; it draws the placeholder line.
 */

export const FUNKY_DEMO: DemoScript = {
  lines: [
    "this:m is:m so:b funky:h@720",
    "keep:b it:m simple:b",
    "good:b vibes:h@660",
    "do:m what:b you:m love:h@680",
    "easy:b come:b go:h@600",
  ],
  options: { rate: 255, cueGap: 150, tail: 900, lead: 400 },
};

export const funkyProgram: SceneProgram = placeholderProgram;
