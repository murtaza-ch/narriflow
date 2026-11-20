import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Cursor (`samples/templates/m03-cursor.js`): not ported yet; it draws the placeholder line.
 */

export const CURSOR_DEMO: DemoScript = {
  lines: [
    "most:m people:b don't:b need:b more:b time",
    "they:m need:b fewer:h@560 tabs:b open",
    "close:b everything",
    "then:m pick:b one:h@520 thing",
    "and:m finish:h@620 it",
  ],
  options: { rate: 270 },
};

export const cursorProgram: SceneProgram = placeholderProgram;
