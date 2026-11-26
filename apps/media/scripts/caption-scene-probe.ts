import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";

/**
 * Raw libass frames for the primitives sheet and the tests: an ASS script burned over a flat
 * background at one time, returned as RGB bytes so ink can be measured without an image library.
 */

export interface RawFrame {
  readonly width: number;
  readonly height: number;
  /** RGB, 3 bytes per pixel, rows top to bottom. */
  readonly data: Uint8Array;
}

export function renderAssRaw(input: { readonly ass: string; readonly width: number; readonly height: number; readonly tMs: number; readonly background?: string; readonly fontsDir?: string }): RawFrame {
  const dir = mkdtempSync(join(tmpdir(), "scene-ass-"));
  const file = join(dir, "t.ass");
  writeFileSync(file, input.ass);
  const run = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${input.background ?? "black"}:s=${input.width}x${input.height}:r=30:d=1`,
      "-vf", `format=rgb24,settb=1/1000000,setpts=${Math.round(input.tMs * 1000) + 300},ass='${file}':fontsdir='${input.fontsDir ?? CAPTION_FONTS_DIRECTORY}'`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ],
    { maxBuffer: 1 << 28 },
  );
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.toString()}`);
  return { width: input.width, height: input.height, data: new Uint8Array(run.stdout) };
}

/** Bounds of the pixels whose luminance differs from the background by more than `threshold` (0..255). */
export function inkBounds(frame: RawFrame, threshold = 24, background = 0): { x1: number; y1: number; x2: number; y2: number } | null {
  let x1 = frame.width;
  let y1 = frame.height;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const at = (y * frame.width + x) * 3;
      const value = Math.max(frame.data[at]!, frame.data[at + 1]!, frame.data[at + 2]!);
      if (Math.abs(value - background) > threshold) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  return x2 < 0 ? null : { x1, y1, x2: x2 + 1, y2: y2 + 1 };
}

export const ASS_HEADER = (width: number, height: number) =>
  [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "Kerning: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Caption,Inter Tight SemiBold,100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,-1",
    "Style: Shape,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");
