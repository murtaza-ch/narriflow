import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { getCaptionPresetById } from "@narriflow/validators";
import { renderCaptionTrack } from "./caption-ass";

/**
 * libass fills a karaoke syllable from its left edge whatever the direction
 * (measured on libass 0.17.4), so an RTL word needs the clip the serializer
 * emits. These frames come from the real ffmpeg/libass and fail if the sweep
 * of an Arabic word ever runs left to right again.
 */
const WIDTH = 1080;
const HEIGHT = 400;
const HIGHLIGHT = [0x00, 0xff, 0x88] as const;

function frame(words: readonly string[], atSec: number): Buffer {
  const preset = getCaptionPresetById("karaoke")!.preset;
  const layer: CompositionCaptionVisualLayer = {
    id: "caption:0", kind: "caption", cueIndex: 0, activeRange: { startSec: 0, endSec: words.length * 0.5 },
    anchor: { xPct: 50, yPct: 50 }, destination: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    rotationDeg: 0, opacity: 1, zIndex: 40, preset,
    words: words.map((text, index) => ({ text, emoji: null, startSec: index * 0.5, endSec: (index + 1) * 0.5 })),
    language: null,
  };
  const directory = mkdtempSync(join(tmpdir(), "caption-rtl-"));
  try {
    const ass = join(directory, "captions.ass");
    writeFileSync(ass, renderCaptionTrack({ layers: [layer], canvas: { width: WIDTH, height: HEIGHT } }).ass);
    const run = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=black:s=${WIDTH}x${HEIGHT}:d=2:r=25`,
      "-vf", `ass='${ass}':fontsdir='${CAPTION_FONTS_DIRECTORY}'`,
      "-ss", String(atSec), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], { maxBuffer: WIDTH * HEIGHT * 3 * 2 });
    if (run.status !== 0) throw new Error(run.stderr.toString());
    return run.stdout;
  } finally {
    rmSync(directory, { recursive: true });
  }
}

/** Left-most and right-most column holding the highlight colour, and how many pixels do. */
function highlight(pixels: Buffer): { left: number; right: number; count: number } {
  let left = WIDTH;
  let right = -1;
  let count = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 3;
      if (Math.abs(pixels[offset]! - HIGHLIGHT[0]) < 24 && Math.abs(pixels[offset + 1]! - HIGHLIGHT[1]) < 24 && Math.abs(pixels[offset + 2]! - HIGHLIGHT[2]) < 24) {
        count++;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return { left, right, count };
}

describe.skipIf(!Bun.which("ffmpeg"))("right-to-left karaoke on the real libass", () => {
  test("an Arabic word fills from its right edge toward the left", () => {
    const words = ["مرحبا", "بالعالم", "العالم"];
    const early = highlight(frame(words, 0.6));
    const late = highlight(frame(words, 0.95));
    // The sung first word sits at the right; the active word grows leftward from it.
    expect(late.count).toBeGreaterThan(early.count);
    expect(late.left).toBeLessThan(early.left - 15);
    expect(late.right).toBeGreaterThan(WIDTH / 2);
    expect(Math.abs(late.right - early.right)).toBeLessThan(6);
  });

  test("a Latin word still fills left to right", () => {
    const words = ["READY", "TO", "GO"];
    const early = highlight(frame(words, 0.6));
    const late = highlight(frame(words, 0.95));
    expect(late.right).toBeGreaterThan(early.right + 10);
    expect(Math.abs(late.left - early.left)).toBeLessThan(6);
  });
});
