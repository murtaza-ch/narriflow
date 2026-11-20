import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Wallpaper (`samples/templates/m09-wallpaper.js`): not ported yet; it draws the placeholder line.
 */

export const WALLPAPER_DEMO: DemoScript = {
  lines: [
    "stop:b chasing:b every:b new:b trend",
    "pick:b ONE:h@560 idea:b",
    "and:m say:b it:m again:b+120",
    "and:m AGAIN:h@620",
    "until:m it:m STICKS:h@640+120",
  ],
  options: { rate: 270, cueGap: 380, tail: 900 },
};

export const wallpaperProgram: SceneProgram = placeholderProgram;
