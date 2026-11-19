/**
 * Ticket 03b render budget (spec section 8): libass time of a 20 s 1080x1920 clip burned with the real
 * Headline painter against Bold Pop, plus events per cue. Local ffmpeg, no Docker image.
 *
 *   bun .scratch/dynamic-captions/references/budget-03b.ts [workDir] [runs]     (from the worktree root)
 *
 * The transcript is the ticket 02 proof's 12 cues (about 20 s) as one utterance, planned through the real
 * composition plan, so grouping, roles and blocks are what an export gets. Input is the proof backdrop looped
 * at 30 fps. "filter" stops after the ass filter (`-f null`); "encode" uses the worker defaults (libx264
 * veryfast, crf 21, yuv420p). Runs are interleaved; the table shows medians.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_FONTS_DIRECTORY } from "../../../packages/caption-fonts/src/index.ts";
import { renderCaptionTrack } from "../../../apps/media/src/caption-ass.ts";
import { type DynamicCaptionFixture, dynamicCaptionLayers } from "../../../apps/media/scripts/dynamic-caption-fixtures.ts";

const HERE = import.meta.dir;
const WORK = Bun.argv[2] ?? join(tmpdir(), "narriflow-budget-03b");
const RUNS = Number(Bun.argv[3] ?? 5);
const BACKDROP = join(HERE, "proof/backdrop.jpg");
const CANVAS = { width: 1080, height: 1920 };
mkdirSync(WORK, { recursive: true });

/** The proof's cues: [text, onset in s from the cue start]; one cue every 1.65 s, each 1.6 s long. */
const CUES: readonly (readonly [string, number])[][] = [
  [["with", 0], ["Accurate", 0.25], ["captions", 0.75]],
  [["the", 0], ["BEST", 0.2], ["part", 0.6]],
  [["I", 0], ["made", 0.15], ["20", 0.45], ["dollars", 0.7]],
  [["This", 0], ["is", 0.15], ["96%", 0.35], ["accurate", 0.8]],
  [["if", 0], ["it", 0.1], ["has", 0.2], ["Captions", 0.4]],
  [["apni", 0], ["Language", 0.3], ["mein", 0.8], ["likho", 1.0]],
  [["you", 0], ["will", 0.12], ["never", 0.3], ["guess", 0.75]],
  [["the", 0], ["secret", 0.12], ["is", 0.4], ["consistency", 0.55]],
  [["got", 0], ["1", 0.25], ["million", 0.4], ["views", 0.85]],
  [["stop", 0], ["wasting", 0.3], ["your", 0.8], ["time", 0.95]],
  [["it", 0], ["changed", 0.15], ["everything", 0.45]],
  [["this", 0], ["is", 0.15], ["HUGE", 0.35]],
];
const words = CUES.flatMap((cue, cueIndex) =>
  cue.map(([word, onset], index) => {
    const startSec = Math.round((cueIndex * 1.65 + onset) * 1000) / 1000;
    const endSec = Math.round((cueIndex * 1.65 + (index + 1 < cue.length ? cue[index + 1]![1] - 0.02 : 1.6)) * 1000) / 1000;
    return { word: index === cue.length - 1 ? `${word}.` : word, key: String(Math.round(startSec * 1000)), startSec, endSec };
  }),
);
const fixture = (presetId: string): DynamicCaptionFixture => ({ id: `budget-${presetId}`, presetId, preset: {}, language: "en", words, overrides: {} });

const tracks = Object.fromEntries(
  (["headline", "bold-pop"] as const).map((presetId) => {
    const layers = dynamicCaptionLayers(fixture(presetId));
    const { ass, geometryUnavailable } = renderCaptionTrack({ layers, canvas: CANVAS });
    if (geometryUnavailable.length > 0) throw new Error(`${presetId}: geometry unavailable`);
    const path = join(WORK, `${presetId}.ass`);
    writeFileSync(path, ass);
    const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
    const seconds = (time: string) => time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
    const perCue = layers.map((cue) =>
      dialogues.filter((line) => {
        const [, start] = line.split(",");
        const at = seconds(start!);
        return at >= Math.round(cue.activeRange.startSec * 100) / 100 && at < Math.round(cue.activeRange.endSec * 100) / 100;
      }).length,
    );
    console.log(`${presetId}: ${layers.length} cues, ${dialogues.length} Dialogue events, per cue min ${Math.min(...perCue)} mean ${(dialogues.length / layers.length).toFixed(1)} max ${Math.max(...perCue)}, blocks ${layers.filter((cue) => cue.block).length}`);
    return [presetId, path];
  }),
) as Record<"headline" | "bold-pop", string>;

function run(mode: "filter" | "encode", ass: string | null): { wall: number; cpu: number } {
  const filter = ass ? ["-vf", `ass='${ass}':fontsdir='${CAPTION_FONTS_DIRECTORY}'`] : [];
  const output = mode === "filter" ? ["-f", "null", "-"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", "30", join(WORK, "out.mp4")];
  const result = spawnSync("/usr/bin/time", ["-p", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-t", "20", "-i", BACKDROP, ...filter, ...output], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  const value = (name: string) => Number(new RegExp(`^${name} ([\\d.]+)`, "m").exec(result.stderr)![1]);
  return { wall: value("real"), cpu: value("user") + value("sys") };
}

const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
const variants = { none: null, "bold-pop": tracks["bold-pop"], headline: tracks.headline } as const;
for (const mode of ["filter", "encode"] as const) {
  const samples: Record<string, { wall: number[]; cpu: number[] }> = {};
  for (let index = 0; index < RUNS; index++) {
    for (const [name, ass] of Object.entries(variants)) {
      const sample = run(mode, ass);
      samples[name] ??= { wall: [], cpu: [] };
      samples[name]!.wall.push(sample.wall);
      samples[name]!.cpu.push(sample.cpu);
    }
  }
  for (const measure of ["wall", "cpu"] as const) {
    const [none, boldPop, headline] = (["none", "bold-pop", "headline"] as const).map((name) => median(samples[name]![measure]));
    console.log(`| ${mode}, ${measure} s | ${none!.toFixed(2)} | ${boldPop!.toFixed(2)} | ${headline!.toFixed(2)} | ${(headline! / boldPop!).toFixed(2)}x |`);
  }
}
