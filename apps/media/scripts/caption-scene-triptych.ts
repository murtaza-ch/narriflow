/**
 * Sample | export | Studio, side by side, for a Scene Style at chosen times, and how far the export
 * and the Studio are from each other.
 *
 *   bun .scratch/motion-captions/tools/triptych.ts <sceneId> <tMs...> [--studio http://localhost:3290] [--no-studio] [--edge <kind>] [--out <dir>]
 *
 * Columns (each 540x960, the 1080x1920 frame halved):
 *   sample  the sample template frozen at t (`.scratch/caption-templates-v2/samples/shot.sh`)
 *   export  the real ASS writer + ffmpeg/libass over the sample's background (`caption-scene-frames.ts`)
 *   studio  the real `CaptionScenePainter` on `/prototype/caption-parity?scene=` over the Studio's copy
 *           of that background; needs `bunx next dev` in apps/web (default http://localhost:3290)
 * The difference is measured on a flat grey background, captions only: the mean absolute difference
 * (0..255, over the three channels) of the pixels either frame inked, inside the caption zone (y 860..1650).
 * Writes `.scratch/motion-captions/out/triptych/<scene>-<t>.png` and prints one JSON line per time.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { type CaptionSceneName, captionSceneMeta } from "@narriflow/validators";
import { sceneDemo } from "./caption-scene-demo";
import { burnSceneFrame } from "./caption-scene-frames";
import { renderAssRaw, type RawFrame } from "./caption-scene-probe";

const ROOT = new URL("../../../", import.meta.url).pathname;
const SAMPLES = join(ROOT, ".scratch/caption-templates-v2/samples");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FLAT = 0x70;

export const SAMPLE_FILES: Readonly<Record<CaptionSceneName, string>> = {
  lyrics: "20-lyrics", dialogue: "31-dialogue", dossier: "51-dossier", hollow: "21-hollow", signal: "40-signal", track: "50-track",
  bulletin: "33-bulletin", ticker: "30-ticker", flap: "32-flap", index: "53-index", punchline: "52-punchline", doodle: "42-doodle",
  velocity: "54-velocity", wordform: "55-wordform", chrome: "23-chrome", reveal: "10-reveal", spine: "43-spine", boom: "41-boom",
  aura: "44-aura", wonky: "m01-wonky", verified: "m02-verified", cursor: "m03-cursor", premiere: "m04-poster", tape: "m05-tape", beat: "m06-beat",
  stretch: "m07-stretch", hype: "m08-sticker", wallpaper: "m09-wallpaper", slice: "m11-slice", arthouse: "m13-cinema", heft: "m14-weight", popup: "m16-y2k",
  trail: "m17-trail", ransom: "m18-collage", ledge: "m19-dropbar", cascade: "m20-mechanica", orbit: "m21-mood",
  shuffle: "m22-unscramble", squash: "m24-squash", slab: "m25-slab", labels: "m26-labels", googly: "m27-googly", bubble: "m28-bubbles", strike: "m29-strike", seventies: "m30-seventies", thermal: "m31-thermal", slot: "m32-slot", inkup: "m33-inkup",
};

export function studioShot(input: { readonly url: string; readonly output: string; readonly width?: number; readonly height?: number }): void {
  const profile = mkdtempSync(join(tmpdir(), "scene-studio-"));
  const run = spawnSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "--force-device-scale-factor=1",
    `--window-size=${input.width ?? 1080},${input.height ?? 1920}`, "--virtual-time-budget=20000", `--screenshot=${input.output}`, input.url,
  ], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`chrome failed: ${run.stderr}`);
}

async function decode(path: string): Promise<RawFrame> {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** Mean absolute difference over the pixels either frame inked on a flat background, inside rows `y1..y2`. */
export function inkDifference(a: RawFrame, b: RawFrame, y1 = 860, y2 = 1650, ink = 8): { mae: number; pixels: number; zoneMae: number } {
  let total = 0;
  let pixels = 0;
  let zone = 0;
  for (let y = y1; y < Math.min(y2, a.height); y++) {
    for (let x = 0; x < a.width; x++) {
      const at = (y * a.width + x) * 3;
      let diff = 0;
      let inked = false;
      for (let c = 0; c < 3; c++) {
        diff += Math.abs(a.data[at + c]! - b.data[at + c]!);
        if (Math.abs(a.data[at + c]! - FLAT) > ink || Math.abs(b.data[at + c]! - FLAT) > ink) inked = true;
      }
      zone += diff / 3;
      if (inked) {
        total += diff / 3;
        pixels++;
      }
    }
  }
  return { mae: pixels ? total / pixels : 0, pixels, zoneMae: zone / ((Math.min(y2, a.height) - y1) * a.width) };
}

/** The export renders at frame times only (libass is handed integer ms at 30 fps); the three columns are taken on that grid. */
export const frameMs = (t: number) => Math.round((Math.round((t * 30) / 1000) * 1000) / 30);

export async function triptych(input: {
  readonly scene: CaptionSceneName;
  readonly times: readonly number[];
  readonly studioUrl?: string | null;
  readonly edge?: string;
  readonly outDir?: string;
}) {
  const { scene } = input;
  const times = input.times.map(frameMs);
  const outDir = input.outDir ?? join(ROOT, ".scratch/motion-captions/out/triptych");
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "scene-tri-"));
  const meta = captionSceneMeta(scene);
  const bg = meta.backdrop;
  const file = SAMPLE_FILES[scene];
  const edge = input.edge;
  if (!edge) {
    const run = spawnSync(join(SAMPLES, "shot.sh"), [`${file}.js`, ...times.map(String)], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(`shot.sh failed: ${run.stderr}`);
  }
  const demo = sceneDemo(scene, edge ? { cues: (await import("@narriflow/caption-scene")).sceneEdgeDemo(edge as never).cues } : {});
  const assPath = join(work, "demo.ass");
  writeFileSync(assPath, demo.ass);
  const results: { t: number; mae: number | null; pixels: number | null; zoneMae: number | null; image: string }[] = [];
  for (const t of times) {
    const exportPng = join(work, `export-${t}.png`);
    burnSceneFrame({ ass: assPath, background: bg, canvas: demo.canvas, tMs: t, output: exportPng });
    const panels: OverlayOptions[] = [];
    const sample = edge ? null : join(SAMPLES, "../shots", `${file}-${t}.png`);
    const cell = async (path: string | null, left: number) => {
      const input = path ? await sharp(path).resize(540, 960).toBuffer() : await sharp({ create: { width: 540, height: 960, channels: 3, background: "#222" } }).png().toBuffer();
      panels.push({ input, left, top: 0 });
    };
    await cell(sample, 0);
    await cell(exportPng, 540);
    let mae: number | null = null;
    let pixels: number | null = null;
    let zoneMae: number | null = null;
    if (input.studioUrl !== null) {
      const base = input.studioUrl ?? "http://localhost:3290";
      const query = (bgName: string) => `scene=${scene}&t=${t}&bg=${bgName}${edge ? `&edge=${edge}` : ""}`;
      const studioPng = join(work, `studio-${t}.png`);
      studioShot({ url: `${base}/prototype/caption-parity?${query(bg)}`, output: studioPng });
      await cell(studioPng, 1080);
      const studioFlat = join(work, `studio-flat-${t}.png`);
      studioShot({ url: `${base}/prototype/caption-parity?${query("flat")}`, output: studioFlat });
      const exportFlat = renderAssRaw({ ass: demo.ass, width: demo.canvas.width, height: demo.canvas.height, tMs: t, background: `0x${FLAT.toString(16).repeat(3)}` });
      ({ mae, pixels, zoneMae } = inkDifference(exportFlat, await decode(studioFlat)));
    } else await cell(null, 1080);
    const image = join(outDir, `${scene}${edge ? `-${edge}` : ""}-${t}.png`);
    await sharp({ create: { width: 1620, height: 960, channels: 3, background: "#000" } }).composite(panels).png().toFile(image);
    results.push({ t, mae, pixels, zoneMae, image });
    console.log(JSON.stringify({ scene, t, mae: mae === null ? null : Math.round(mae * 100) / 100, pixels, image }));
  }
  return results;
}

export async function main(args: string[]) {
  const take = (flag: string) => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args.splice(at, 2)[1];
  };
  const studio = take("--studio");
  const edge = take("--edge");
  const out = take("--out");
  const noStudio = args.includes("--no-studio");
  const [scene, ...times] = args.filter((arg) => arg !== "--no-studio");
  if (!scene || times.length === 0) throw new Error("usage: triptych.ts <sceneId> <tMs...> [--studio URL] [--no-studio] [--edge kind] [--out dir]");
  await triptych({ scene: scene as CaptionSceneName, times: times.map(Number), studioUrl: noStudio ? null : studio, ...(edge ? { edge } : {}), ...(out ? { outDir: out } : {}) });
}

if (import.meta.main) await main(process.argv.slice(2));
