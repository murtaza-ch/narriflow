import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Snip Snap (`samples/templates/m66-snipsnap.js`): not ported yet; it draws the placeholder line.
 */

export const SNIPSNAP_DEMO: DemoScript = {
  lines: [
    "your:m bright:b story:h@700",
    "change:b the:m game:h@560",
    "make:b your:m own:b magic:h@660",
    "just:m keep:b it:m simple:b",
    "focus:b on:m creativity:h@820",
  ],
  options: { rate: 260, cueGap: 150, tail: 900, lead: 400 },
};

export const snipsnapProgram: SceneProgram = placeholderProgram;
