import type { DemoScript } from "../demo";
import type { SceneProgram } from "../input";
import { placeholderProgram } from "./placeholder";

/**
 * Anime (`samples/templates/m65-anime.js`) (the sample's "Anime Graphics"): not ported yet; it draws the placeholder line.
 */

export const ANIME_DEMO: DemoScript = {
  lines: [
    "this:m will:b blow:b your:m mind:h@720",
    "nobody:b tells:b you:m this:m",
    "stop:b wasting:b time:h@600",
    "you:m just:m leveled:b up:h@560",
    "ready:b player:b one:h@640",
  ],
  options: { rate: 255, cueGap: 150, tail: 900, lead: 400 },
};

export const animeProgram: SceneProgram = placeholderProgram;
