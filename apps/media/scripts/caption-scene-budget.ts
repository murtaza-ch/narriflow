/**
 * Render budget (spec 5.5): libass time of a Scene Style's sample looped to 60 s at 1080x1920, against
 * Headline on the same words, through the real plan and the real writer.
 *
 *   bun apps/media/scripts/caption-scene-budget.ts [sceneId ...] [--captions-only] [--runs N] [--threads N]
 *
 * Default (the official budget, limit 1.5x Headline): the full export, a 1920x1080 source cropped and scaled to
 * 1080x1920, the ASS burned in, libx264 veryfast crf 21. `--captions-only` times the libass burn alone over a flat
 * grey frame (no source, no encode). Each template is timed against Headline on the SAME words, alternating the two
 * runs so machine load hits both, best of N (default 3). Prints events, ASS size, CPU (user + sys) and wall seconds
 * of each, and both ratios; judge by the CPU ratio when the machine is loaded. libass is one thread in front of a
 * multi-threaded encoder, so the wall ratio reads higher than the CPU ratio; `--threads 4` caps x264 at the render
 * container's 4 vCPUs (`modal_app.py` `RENDER_RESOURCES`) to read the wall ratio a user waits for.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import { captionSceneDemo } from "@narriflow/caption-scene";
import { type CompositionCaptionVisualLayer, planClipComposition } from "@narriflow/composition-plan";
import { CAPTION_SCENE_NAMES, captionPresetSchema, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { renderCaptionTrack } from "../src/caption-ass";

const CANVAS = { width: 1080, height: 1920 };
const SECONDS = 60;

function layersFor(presetId: string, name: Parameters<typeof captionSceneDemo>[0]): CompositionCaptionVisualLayer[] {
  const { cues, duration } = captionSceneDemo(name);
  const loops = Math.ceil((SECONDS * 1000) / duration);
  const utterances = Array.from({ length: loops }, (_, loop) =>
    cues.map((cue, index) => {
      const offset = (loop * duration) / 1000;
      const words = cue.words.map((word) => ({ word: word.text, startSec: offset + word.startMs / 1000, endSec: offset + word.endMs / 1000, confidence: 1 }));
      return { index: loop * cues.length + index, speaker: 0, speakerLabel: "Speaker 1", startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, text: words.map((w) => w.word).join(" "), confidence: 1, words };
    }),
  ).flat().filter((utterance) => utterance.endSec < SECONDS);
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: SECONDS,
    captionPreset: captionPresetSchema.parse(getCaptionPresetById(presetId)!.preset),
    transcriptSlice: utterances,
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null,
    deletedRanges: [],
  });
  const result = planClipComposition({
    document,
    captionLanguage: "en",
    source: { identity: "source:budget", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, music: {} },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: CANVAS.width, height: CANVAS.height }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan.targets[0]!.visualLayers.flatMap((layer): CompositionCaptionVisualLayer[] => (layer.kind === "caption" ? [layer] : []));
}

const FILTER_FULL = "crop=608:1080,scale=1080:1920";

/** One burn: wall seconds and CPU seconds (user + sys, `/usr/bin/time -p`) of the ffmpeg process. */
function burn(file: string, captionsOnly: boolean, threads: number | null): { wall: number; cpu: number } {
  const source = captionsOnly
    ? `color=c=0x606060:s=${CANVAS.width}x${CANVAS.height}:r=30:d=${SECONDS}`
    : `testsrc2=s=1920x1080:r=30:d=${SECONDS}`;
  const filter = `${captionsOnly ? "" : `${FILTER_FULL},`}ass='${file}':fontsdir='${CAPTION_FONTS_DIRECTORY}'`;
  const encode = captionsOnly ? [] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", ...(threads ? ["-threads", String(threads)] : [])];
  const started = performance.now();
  const result = spawnSync("/usr/bin/time", ["-p", "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", source, "-vf", filter, ...encode, "-f", "null", "-"], { encoding: "utf8" });
  const wall = (performance.now() - started) / 1000;
  if (result.status !== 0) throw new Error(result.stderr);
  const seconds = (label: string) => Number(new RegExp(`^${label} ([0-9.]+)`, "m").exec(result.stderr)?.[1] ?? Number.NaN);
  return { wall, cpu: seconds("user") + seconds("sys") };
}

function writeAss(ass: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scene-budget-"));
  const file = join(dir, "t.ass");
  writeFileSync(file, ass);
  return file;
}

const args = process.argv.slice(2);
const captionsOnly = args.includes("--captions-only");
const runsFlag = args.indexOf("--runs");
const RUNS = runsFlag >= 0 ? Number(args[runsFlag + 1]) : 3;
const threadsFlag = args.indexOf("--threads");
/** The render container has 4 vCPUs (`RENDER_RESOURCES`): `--threads 4` lets x264 use no more, so the wall ratio is the container's. */
const THREADS = threadsFlag >= 0 ? Number(args[threadsFlag + 1]) : null;
const requested = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--runs" && args[index - 1] !== "--threads");
const names = (requested.length > 0 ? requested : CAPTION_SCENE_NAMES) as Parameters<typeof captionSceneDemo>[0][];
const trackFor = (presetId: string, name: Parameters<typeof captionSceneDemo>[0]) => renderCaptionTrack({ layers: layersFor(presetId, name), canvas: CANVAS });
const events = (ass: string) => ass.split("\n").filter((line) => line.startsWith("Dialogue:")).length;

console.log(`${captionsOnly ? "captions only (flat grey, no encode)" : "full export (crop+scale, ASS burn, libx264 veryfast crf 21)"}; ${SECONDS} s at ${CANVAS.width}x${CANVAS.height}; best of ${RUNS} interleaved runs; limit 1.5x Headline on the full export`);
console.log("template    events  KiB   headline cpu/wall   template cpu/wall   ratio cpu  ratio wall");
for (const name of names) {
  // Headline on this template's own words, run alternately with the template so machine load hits both.
  const headline = trackFor("headline", name);
  const scene = trackFor(name, name);
  const headlineFile = writeAss(headline.ass);
  const sceneFile = writeAss(scene.ass);
  const best = { headline: { wall: Number.POSITIVE_INFINITY, cpu: Number.POSITIVE_INFINITY }, scene: { wall: Number.POSITIVE_INFINITY, cpu: Number.POSITIVE_INFINITY } };
  for (let run = 0; run < RUNS; run++) {
    for (const [key, file] of [["headline", headlineFile], ["scene", sceneFile]] as const) {
      const sample = burn(file, captionsOnly, THREADS);
      best[key] = { wall: Math.min(best[key].wall, sample.wall), cpu: Math.min(best[key].cpu, sample.cpu) };
    }
  }
  const pair = (value: { wall: number; cpu: number }) => `${value.cpu.toFixed(2)}/${value.wall.toFixed(2)} s`;
  console.log(
    `${name.padEnd(10)} ${String(events(scene.ass)).padStart(6)} ${(scene.ass.length / 1024).toFixed(0).padStart(5)}   ${pair(best.headline).padEnd(18)}  ${pair(best.scene).padEnd(18)}  ${(best.scene.cpu / best.headline.cpu).toFixed(2)}x      ${(best.scene.wall / best.headline.wall).toFixed(2)}x`,
  );
}
