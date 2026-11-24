import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Seventies (`samples/templates/m30-seventies.js`): not ported yet; it draws the placeholder line.
 */

export const SEVENTIES_DEMO: DemoScript = {
  lines: [
    "this:m recipe:b changed:b my:m life:h@520",
    "three:b simple:b ingredients",
    "no:b oven:b needed:h@520",
    "just:m mix:b and:m smile:h@520",
    "grandma:b was:m right:h@520",
    "sunday:b dinner:b",
  ],
  options: { rate: 255, cueGap: 120 },
};

export const seventiesProgram: SceneProgram = placeholderProgram;
