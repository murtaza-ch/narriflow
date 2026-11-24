import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Inkup (`samples/templates/m33-inkup.js`): not ported yet; it draws the placeholder line.
 */

export const INKUP_DEMO: DemoScript = {
  lines: [
    "most:b people:b quit:b right:m before:b it:m works:h@560",
    "nobody:b remembers:b your:m plan",
    "ship:h@520 it:m ugly:b",
    "consistency:h@760 beats:b talent",
    "start:b before:b you're:m ready:h@520",
  ],
  options: { rate: 235, gap: 22, cueGap: 150, tail: 700, lead: 350 },
};

export const inkupProgram: SceneProgram = placeholderProgram;
