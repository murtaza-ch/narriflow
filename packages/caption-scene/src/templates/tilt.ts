import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Tilt (the sample's "Hype3D"; the Hype style owns that name) (`samples/templates/m68-hype3d.js`): not ported yet; it draws the placeholder line.
 */

export const TILT_DEMO: DemoScript = {
  lines: [
    "this:m is:m the:m game:b changer:h@640",
    "no:b one:b tells:b you:m this:h@560",
    "keep:b it:m loud:b",
    "go:b big:b or:m go:b home:h@560",
    "wait:h@600",
  ],
  options: { rate: 205, gap: 40, cueGap: 200, tail: 640, lead: 320 },
};

export const tiltProgram: SceneProgram = placeholderProgram;
