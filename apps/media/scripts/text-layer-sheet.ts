import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import { TEXT_LAYER_SAMPLES } from "@narriflow/caption-scene";
import type { CompositionTextVisualLayer } from "@narriflow/composition-plan";
import { assTime } from "../src/ass-format";
import { renderTextLayerTrack } from "../src/text-layer-ass";

/**
 * Contact sheet of the Text Layer samples through the real export path: `renderTextLayerTrack`
 * (the shared layout, HarfBuzz measurement, the ASS writer) burned by FFmpeg + libass, on a flat
 * colour and on a photo-like gradient, at 1080 x 1920 and 1920 x 1080. The Studio prototype page
 * draws the same `TEXT_LAYER_SAMPLES` with the real painter.
 *
 *   bun apps/media/scripts/text-layer-sheet.ts [outDir]   (default .scratch/title-text/sheet)
 *
 * Each sample owns one 100 ms frame of a 10 fps clip; `tile` lays the frames out, half size.
 */

const FPS = 10;
const FRAME_MS = 1000 / FPS;
const ROOT = new URL("../../../", import.meta.url).pathname;
const outDir = resolve(process.argv[2] ?? join(ROOT, ".scratch/title-text/sheet"));

const CANVASES = [
  { name: "vertical", width: 1080, height: 1920, columns: 7 },
  { name: "horizontal", width: 1920, height: 1080, columns: 5 },
] as const;

const BACKGROUNDS = {
  flat: (width: number, height: number, seconds: number) => `color=c=0x3B6E8F:s=${width}x${height}:r=${FPS}:d=${seconds}`,
  photo: (width: number, height: number, seconds: number) =>
    `gradients=s=${width}x${height}:r=${FPS}:d=${seconds}:c0=0x1C2541:c1=0xE9C46A:c2=0xF4A261:c3=0x2A9D8F:nb_colors=4:type=radial:speed=0`,
} as const;

/** The sample's label in the frame's bottom-left corner (plain ASS, not part of the layout). */
function labelEvent(index: number, label: string, height: number): string {
  const start = assTime((index * FRAME_MS) / 1000);
  const end = assTime(((index + 1) * FRAME_MS) / 1000);
  return `Dialogue: 999,${start},${end},Caption,,0,0,0,,{\\an1\\pos(24,${height - 24})\\fnInter 28pt ExtraBold\\fs40\\1c&H00FFFF&\\3c&H000000&\\bord3\\shad0}${index + 1}. ${label}`;
}

mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "text-layer-sheet-"));
const written: string[] = [];
for (const canvas of CANVASES) {
  const layers: CompositionTextVisualLayer[] = TEXT_LAYER_SAMPLES.flatMap((sample, index) =>
    sample.layers.map((value) => ({
      id: `layer:text:${value.id}:${sample.id}`,
      kind: "text" as const,
      activeRange: { startSec: (index * FRAME_MS) / 1000, endSec: ((index + 1) * FRAME_MS) / 1000 },
      anchor: { xPct: value.positionX, yPct: value.positionY },
      destination: { x: 0, y: 0, width: canvas.width, height: canvas.height },
      rotationDeg: 0 as const,
      opacity: 1 as const,
      zIndex: 30 as const,
      value,
    })),
  );
  const track = renderTextLayerTrack({ layers, canvas, fps: FPS });
  if (track.omitted.length > 0) console.warn(JSON.stringify({ level: "warn", message: "text_layer_sheet_omitted", canvas: canvas.name, omitted: track.omitted }));
  const ass = `${track.ass.trimEnd()}\n${TEXT_LAYER_SAMPLES.map((sample, index) => labelEvent(index, sample.label, canvas.height)).join("\n")}\n`;
  const assPath = join(work, `${canvas.name}.ass`);
  writeFileSync(assPath, ass);
  const count = TEXT_LAYER_SAMPLES.length;
  const rows = Math.ceil(count / canvas.columns);
  const seconds = (count * FRAME_MS) / 1000;
  for (const [background, source] of Object.entries(BACKGROUNDS)) {
    const out = join(outDir, `${canvas.name}-${background}.png`);
    const run = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", source(canvas.width, canvas.height, seconds),
        "-vf", `ass='${assPath}':fontsdir='${CAPTION_FONTS_DIRECTORY}',scale=iw/2:ih/2,tile=${canvas.columns}x${rows}:padding=8:color=0x111111`,
        "-frames:v", "1", out,
      ],
      { encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`ffmpeg failed for ${out}: ${run.stderr}`);
    if (run.stderr.trim()) console.warn(run.stderr.trim());
    written.push(out);
  }
}
console.log(written.join("\n"));
