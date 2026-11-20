import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Popup (`samples/templates/m16-y2k.js`): not ported yet; it draws the placeholder line.
 */

export const POPUP_DEMO: DemoScript = {
  lines: [
    "my:m edits:b used:b to:m take:b hours",
    "now:m it's:m basically:b instant:h@600",
    "one:m button",
    "and:m it:m looks:b so:m clean:h@600",
    "seriously:h@640 try:b it",
  ],
  options: { rate: 270 },
};

export const popupProgram: SceneProgram = placeholderProgram;
