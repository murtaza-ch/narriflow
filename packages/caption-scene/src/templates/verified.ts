import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Verified (`samples/templates/m02-verified.js`): not ported yet; it draws the placeholder line.
 */

export const VERIFIED_DEMO: DemoScript = {
  lines: [
    "I:m tried:b every:m morning:b routine",
    "only:m one:m stuck:h@520 for:m a:m year",
    "no:m alarm:b no:m phone",
    "just:m sunlight:h@600 and:m water",
    "try:b it:m tomorrow:h@620",
  ],
  options: { rate: 270 },
};

export const verifiedProgram: SceneProgram = placeholderProgram;
