import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Swoosh (`samples/templates/m77-swoosh.js`): not ported yet; it draws the placeholder line.
 */

export const SWOOSH_DEMO: DemoScript = {
  lines: [
    "nobody:b believed:b in:m me:m",
    "so:m I:m built:h@500 it:m myself:b",
    "dream:h@540 bigger:b",
    "never:b stop:b",
    "someday:b it:m will:b click:h@520",
    "you:m got:h@480 this:b",
  ],
  options: { rate: 195, gap: 30, cueGap: 520, tail: 270, lead: 300 },
};

export const swooshProgram: SceneProgram = placeholderProgram;
