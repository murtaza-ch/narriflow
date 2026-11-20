/**
 * Scene Style frames: a template's own sample script, built by its program, written by the real ASS
 * writer and burned with the real ffmpeg/libass over the sample's background, so the export column of
 * the triptych (`.scratch/motion-captions/tools/triptych.ts`) is the export itself.
 *
 *   bun apps/media/scripts/caption-scene-frames.ts <outDir> <sceneId> <tMs...> [--bg dark|bright|busy] [--size 1080x1920]
 *
 * Writes `<outDir>/<sceneId>.ass` and `<outDir>/<sceneId>-<tMs>.png`, each a full frame at the size
 * (default 1080x1920) with the frame frozen `tMs` into the sample's loop.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import { CAPTION_SCENE_NAMES, type CaptionSceneName, captionSceneMeta } from "@narriflow/validators";
import { type DynamicCaptionBackground, dynamicCaptionBackgroundPath } from "./dynamic-caption-fixtures";
import { sceneDemo } from "./caption-scene-demo";

export function burnSceneFrame(input: {
  readonly ass: string;
  readonly background: DynamicCaptionBackground;
  readonly canvas: { width: number; height: number };
  readonly tMs: number;
  readonly output: string;
}): void {
  const { canvas } = input;
  const run = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", dynamicCaptionBackgroundPath(input.background),
      "-vf", `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${canvas.width}:${canvas.height},settb=1/1000000,setpts=${Math.round(input.tMs * 1000) + 300},ass='${input.ass}':fontsdir='${CAPTION_FONTS_DIRECTORY}'`,
      "-frames:v", "1", input.output,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`ffmpeg failed at ${input.tMs} ms: ${run.stderr}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    return args.splice(at, 2)[1];
  };
  const bg = option("--bg") as DynamicCaptionBackground | undefined;
  const size = option("--size")?.split("x").map(Number);
  const [outDir, sceneId, ...times] = args;
  if (!outDir || !sceneId || times.length === 0 || !(CAPTION_SCENE_NAMES as readonly string[]).includes(sceneId)) {
    throw new Error("usage: caption-scene-frames.ts <outDir> <sceneId> <tMs...> [--bg dark|bright|busy] [--size WxH]");
  }
  const name = sceneId as CaptionSceneName;
  const canvas = size && size.length === 2 ? { width: size[0]!, height: size[1]! } : { width: 1080, height: 1920 };
  mkdirSync(outDir, { recursive: true });
  const demo = sceneDemo(name, { canvas });
  const ass = join(outDir, `${name}.ass`);
  writeFileSync(ass, demo.ass);
  const background = bg ?? captionSceneMeta(name).backdrop;
  for (const time of times) {
    const output = join(outDir, `${name}-${time}.png`);
    burnSceneFrame({ ass, background, canvas, tMs: Number(time), output });
    console.log(output);
  }
}
