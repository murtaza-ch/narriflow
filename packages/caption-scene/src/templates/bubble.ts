import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Bubble (`samples/templates/m28-bubbles.js`) (the sample's "Neon"; a classic preset already owns that name): not ported yet; it draws the placeholder line.
 */

export const BUBBLE_DEMO: DemoScript = {
  lines: [
    "wait:h@450 you:m did:b what:b",
    "i:m just:m tested:b it:m for:m a:m week:b",
    "no_way:h@620 it:m works:b",
    "and:m it:m costs:b nothing:b",
    "yes:h@420 lets:b go:b",
  ],
  options: { rate: 225, gap: 30, cueGap: 240, tail: 600, lead: 300 },
};

export const bubbleProgram: SceneProgram = placeholderProgram;
