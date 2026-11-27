import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import type { SceneCue } from "@narriflow/caption-scene";
import { getCaptionPresetById } from "@narriflow/validators";
import { sceneDemo } from "../scripts/caption-scene-demo";
import { assScript } from "./caption-ass";
import { sceneEvents } from "./caption-scene-ass";

/**
 * Helium's one shine per word for scripts Fredoka cannot draw is a white copy of the word seen through a small pill. It
 * only shows where the pill meets ink, so these frames come from the real HarfBuzz layout and libass with nothing but the
 * shine pieces drawn: every common Hindi, Urdu and Chinese word must show some white (wave 7 review: और and फिर showed
 * none when the pill sat on the ink box instead of a stroke).
 */
const WIDTH = 1080;
const HEIGHT = 1920;

function shinePixels(words: readonly string[], language: string): number[] {
  const cues: SceneCue[] = words.map((text, index) => ({
    index, speaker: 0, language, startMs: 300 + index * 1000, endMs: 1100 + index * 1000,
    words: [{ text, startMs: 300 + index * 1000, endMs: 900 + index * 1000, role: "body", key: null }],
  }));
  const demo = sceneDemo("helium", { cues, fps: 30 });
  const shines = demo.scene.pieces.filter((piece) => /^helium:\d+:w\d+g$/.test(piece.id) && piece.kind === "text");
  expect(shines.length).toBe(words.length);
  const preset = getCaptionPresetById("helium")!.preset;
  const directory = mkdtempSync(join(tmpdir(), "helium-shine-"));
  try {
    const ass = join(directory, "shine.ass");
    writeFileSync(ass, assScript(sceneEvents({ pieces: shines }, demo.measurer, { canvas: demo.canvas, fps: 30 }), demo.canvas, preset));
    return words.map((_, index) => {
      const run = spawnSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `color=c=black:s=${WIDTH}x${HEIGHT}:d=${words.length + 1}:r=30`,
        "-vf", `ass='${ass}':fontsdir='${CAPTION_FONTS_DIRECTORY}'`,
        "-ss", String((1000 + index * 1000) / 1000), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-",
      ], { maxBuffer: WIDTH * HEIGHT * 2 });
      if (run.status !== 0) throw new Error(run.stderr.toString());
      let lit = 0;
      for (const value of run.stdout) if (value > 160) lit++;
      return lit;
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("Helium's word shine lands on a stroke the shaped word really has", () => {
  test("Hindi: the streak sits on the headline of every word", () => {
    const lits = shinePixels(["और", "फिर", "देखो", "कम", "इतना", "सीधा", "बहुत"], "hi"); for (const lit of lits) expect(lit).toBeGreaterThan(40);
  }, 60_000);

  test("Urdu: the tip of the tallest letter catches the light", () => {
    const lits = shinePixels(["کے", "بہت", "اچھا", "ضروری", "سوچا", "ہے"], "ur"); for (const lit of lits) expect(lit).toBeGreaterThan(20);
  }, 60_000);

  test("Chinese: the top stroke of one character, never a bar across neighbours", () => {
    const lits = shinePixels(["天气", "我们", "问题"], "zh"); for (const lit of lits) expect(lit).toBeGreaterThan(20);
  }, 60_000);
});
