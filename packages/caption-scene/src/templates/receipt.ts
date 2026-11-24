import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Receipt (`samples/templates/m58-receipt.js`): not ported yet; it draws the placeholder line.
 */

export const RECEIPT_DEMO: DemoScript = {
  lines: [
    "most:b people:b track:b their:m spending:b",
    "but:m never:b their:m time:h@560",
    "you:m get:m 24:b hours:b a:m day:m",
    "same:b as:m everyone:b",
    "spend:b it:m like:m money:h@520",
  ],
  options: { rate: 235, cueGap: 280, lead: 420, tail: 700, gap: 28 },
};

export const receiptProgram: SceneProgram = placeholderProgram;
