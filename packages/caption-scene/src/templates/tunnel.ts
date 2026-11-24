import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Tunnel (`samples/templates/m64-tunnel.js`): not ported yet; it draws the placeholder line.
 */

export const TUNNEL_DEMO: DemoScript = {
  lines: [
    "most:m people:b quit:b",
    "right:m before:m the:m breakthrough:h@720",
    "so:m keep:b going:b",
    "deeper:h@640 every:b day:b",
    "that's:m how:m you:m win:h@620",
  ],
  options: { rate: 270, cueGap: 150, tail: 850, lead: 380 },
};

export const tunnelProgram: SceneProgram = placeholderProgram;
