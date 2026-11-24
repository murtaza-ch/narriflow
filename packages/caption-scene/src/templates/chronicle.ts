import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Chronicle (`samples/templates/m55-chronicle.js`): not ported yet; it draws the placeholder line.
 */

export const CHRONICLE_DEMO: DemoScript = {
  lines: [
    "in:m 1969:b@640 humans:b walked:h@600",
    "on:m the:m moon:b",
    "so:m why:b did:m we:m ever:b stop?:h@640",
    "money:b+650 politics:b and:m fear:h@620",
    "by:m 1972:b@640 it:m was:m over:h@600",
  ],
  options: { rate: 290, cueGap: 200, tail: 900 },
};

export const chronicleProgram: SceneProgram = placeholderProgram;
