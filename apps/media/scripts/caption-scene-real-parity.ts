/**
 * Studio vs export on a REAL clip (ticket 04): the export frame of the rendered MP4 beside the Studio's real scene
 * painter drawing the same clip's cues, and how far apart they are.
 *
 *   bun apps/media/scripts/caption-scene-real-parity.ts --dir <clipDir> --preset <id> --times <sec,sec,...> [--studio http://localhost:3290]
 *
 * Needs `<clipDir>/renders/<preset>.mp4`, `<preset>.ass` and `none.mp4` (the same clip rendered without captions,
 * `caption-scene-real-render.ts --presets none`), and the Studio dev server (`bunx next dev -p 3290` in apps/web).
 * Columns (540x960 each): export (the MP4 frame) | Studio over the same frame of the caption-free render.
 * `mae` is measured as the ticket-01 tools do, on a flat grey background, captions only: the real ASS burned over grey
 * at the frame time against the Studio page's `bg=flat`, over the pixels either inked (0..255, 3 channels; the
 * threshold a template passes is 18). Writes `<clipDir>/renders/parity/<preset>-<ms>.png` and prints one JSON line a time.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import sharp from "sharp";
import { renderAssRaw } from "./caption-scene-probe";
import { inkDifference, studioShot } from "./caption-scene-triptych";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function frameRate(path: string): number {
  const run = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path], { encoding: "utf8" });
  const [num, den] = run.stdout.trim().split("/").map(Number);
  return num! / (den || 1);
}

function extractFrame(mp4: string, timeSec: number, output: string): void {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(timeSec), "-i", mp4, "-frames:v", "1", output], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`frame ${timeSec}: ${run.stderr}`);
}

async function decode(path: string) {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = resolve(option(args, "--dir") ?? "");
  const preset = option(args, "--preset");
  const times = (option(args, "--times") ?? "").split(",").filter(Boolean).map(Number);
  const studio = option(args, "--studio") ?? "http://localhost:3290";
  if (!preset || times.length === 0) throw new Error("usage: caption-scene-real-parity.ts --dir <clipDir> --preset <id> --times <sec,..> [--studio URL]");
  const renders = join(dir, "renders");
  const clip = basename(dir);
  const mp4 = join(renders, `${preset}.mp4`);
  const none = join(renders, "none.mp4");
  const ass = readFileSync(join(renders, `${preset}.ass`), "utf8");
  const fps = frameRate(mp4);
  mkdirSync(join(renders, "bg"), { recursive: true });
  mkdirSync(join(renders, "parity"), { recursive: true });
  const work = join(renders, "parity", "_work");
  mkdirSync(work, { recursive: true });

  for (const requested of times) {
    // The export draws on output frame times; take the Studio at the same instant, in whole ms (the page's `t`).
    const frameTime = Math.round(requested * fps) / fps;
    const ms = Math.round(frameTime * 1000);
    const exportPng = join(work, `export-${ms}.png`);
    // `-ss` keeps the first frame at or after the time: ask for just before the frame's own pts.
    extractFrame(mp4, frameTime - 0.0005, exportPng);
    const bgPath = join(renders, "bg", `${ms}.png`);
    extractFrame(none, frameTime - 0.0005, bgPath);
    // ffmpeg tags its PNGs with colour info (cICP) that Chrome applies to a CSS background; the export frame has none: strip it.
    await sharp(bgPath).removeAlpha().png().toFile(`${bgPath}.stripped`);
    renameSync(`${bgPath}.stripped`, bgPath);
    const studioPng = join(work, `studio-${ms}.png`);
    studioShot({ url: `${studio}/prototype/caption-parity?real=${clip}&preset=${preset}&t=${ms}&bg=frame`, output: studioPng });
    const studioFlat = join(work, `studio-flat-${ms}.png`);
    studioShot({ url: `${studio}/prototype/caption-parity?real=${clip}&preset=${preset}&t=${ms}&bg=flat`, output: studioFlat });
    const exportFlat = renderAssRaw({ ass, width: 1080, height: 1920, tMs: ms, background: "0x707070" });
    const { mae, pixels } = inkDifference(exportFlat, await decode(studioFlat), 0, 1840); // rows below 1840 hold Next's dev badge
    const image = join(renders, "parity", `${preset}-${ms}.png`);
    const panel = async (path: string, left: number) => ({ input: await sharp(path).resize(540, 960).toBuffer(), left, top: 0 });
    await sharp({ create: { width: 1080, height: 960, channels: 3, background: "#000" } }).composite([await panel(exportPng, 0), await panel(studioPng, 540)]).png().toFile(image);
    console.log(JSON.stringify({ clip, preset, t: ms, mae: Math.round(mae * 100) / 100, pixels, image }));
  }
}

await main();
