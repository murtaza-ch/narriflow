/**
 * Real-clip render of the Scene Styles through the production path (ticket 04).
 *
 *   bun apps/media/scripts/caption-scene-real-render.ts --doc <document.json> --evidence <evidence.json> \
 *     --source <source.mp4> --out <dir> [--presets all|id,id,...] [--aspect 9:16]
 *
 * The script holds no data. `document.json` is a clip's editor document (`caption-scene-real-fetch.ts` writes it),
 * `evidence.json` its stored layout analyses, `source.mp4` the source object. Per preset it runs what the render
 * worker runs, as `render-golden.ts` does: inspectMedia -> planClipComposition (the document's own clip timing, deleted
 * ranges and stored automatic-layout evidence; only `captionPreset` swapped, through `applyCaptionPresetLook` as the
 * Studio does) -> audio schedule -> renderCaptionTrack (compileCompositionPlanCaptions) -> compileClipCompositionCommand ->
 * ffmpeg with the production encoder settings (`parseRenderConfig`: x264 veryfast, crf 21) and thread policy ->
 * `validateRenderOutput`. Not run: the mix-peak guard (audio is the same for every preset) and asset fetches (no logo,
 * music, B-roll or brand fonts: a clip that asks for them renders without).
 *
 * `--presets all` renders the 16 Motion presets, Headline and the document's own preset (`current`) as references; `none` is
 * the clip without captions (a comma list mixes them: `all,none`).
 * Output: `<dir>/<preset>.mp4`, `<dir>/<preset>.ass`, and `<dir>/timings.json` (wall and CPU seconds, events, bytes).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CAPTION_SCENE_NAMES } from "@narriflow/validators";
import { prepareCaptionFontsDirectory } from "../src/brand-font-resolution";
import { CAPTION_RENDER_DIAGNOSTIC_PATTERN, captionRenderDiagnosticsFailure, classifyCaptionRenderDiagnostics } from "../src/caption-glyphs";
import {
  bindCompositionPlanAudioInputs,
  compileClipCompositionCommand,
  compileCompositionPlanAudioSchedule,
  compileCompositionPlanCaptions,
  renderOutputFrameRate,
} from "../src/composition-ffmpeg-adapter";
import { renderFfmpegArgs } from "../src/ffmpeg-thread-policy";
import { transportRenderCommand } from "../src/render-command-transport";
import { parseRenderConfig } from "../src/render-config";
import { compositionOutputExpectation, validateRenderOutput } from "../src/render-output-validation";
import { productionWorkerProcessModule } from "../src/worker-process";
import { createRealPlanner } from "./caption-scene-real-plan";

export interface RealRenderTiming {
  preset: string;
  presetId: string;
  wallSec: number;
  cpuSec: number;
  userSec: number;
  sysSec: number;
  events: number;
  assBytes: number;
  outputBytes: number;
  exitCode: number | null;
  validation: "ok" | string;
  diagnostics: string[];
}

const round = (value: number) => Math.round(value * 100) / 100;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** ffmpeg under `/usr/bin/time -p`: wall seconds and CPU seconds (user + sys) of the process. */
function timedFfmpeg(argv: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string; wall: number; user: number; sys: number }> {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn("/usr/bin/time", ["-p", "ffmpeg", ...argv], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, AV_LOG_FORCE_NOCOLOR: "1" } });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const seconds = (label: string) => Number(new RegExp(`^${label} ([0-9.]+)`, "m").exec(stderr)?.[1] ?? Number.NaN);
      done({ code, stderr, wall: (performance.now() - started) / 1000, user: seconds("user"), sys: seconds("sys") });
    });
  });
}

export async function renderRealClip(input: {
  document: unknown;
  evidence: { automatic?: unknown } | null;
  sourcePath: string;
  outDir: string;
  presets: string[];
  aspectRatio?: string;
  signal?: AbortSignal;
}): Promise<RealRenderTiming[]> {
  const signal = input.signal ?? new AbortController().signal;
  await mkdir(join(input.outDir, "work"), { recursive: true });
  const planner = await createRealPlanner({ document: input.document, evidence: input.evidence, sourcePath: input.sourcePath, aspectRatio: input.aspectRatio, signal });
  const { baseDocument, inspection, cutPlan } = planner;
  const config = parseRenderConfig({});
  const encoder = { preset: config.x264Preset, crf: config.x264Crf };
  const audio = bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(planner.planDocument(baseDocument)), { music: [], soundEffects: [] });
  // The worker writes Scene Style captions for the frame times of the rate the render is delivered at (`renderOutputFrameRate`).
  const outputRate = renderOutputFrameRate(inspection);
  const captionFps = outputRate.numerator / outputRate.denominator;
  const fonts = await prepareCaptionFontsDirectory(join(input.outDir, "work"), new Map(), null);

  const timings: RealRenderTiming[] = [];
  for (const name of input.presets) {
    // `none` is the clip without captions (the frame the Studio column of the parity check is painted over): Headline's
    // plan and script with every event removed, so the composition is otherwise identical.
    const document = name === "none" ? planner.documentFor("headline") : planner.documentFor(name);
    const plan = planner.planDocument(document);
    const track = compileCompositionPlanCaptions(plan, "vertical", new Map(), undefined, captionFps);
    const captions = name === "none" ? { ...track, ass: track.ass.split("\n").filter((line) => !line.startsWith("Dialogue:")).join("\n") } : track;
    const subtitlePath = join(input.outDir, `${name}.ass`);
    await writeFile(subtitlePath, captions.ass, "utf8");
    const outputPath = join(input.outDir, `${name}.mp4`);
    await rm(outputPath, { force: true });
    const argv = compileClipCompositionCommand({
      sourcePath: input.sourcePath, outputPath, startSec: document.clipStartSec, endSec: document.clipEndSec, source: inspection, plan, targetId: "vertical",
      audio, encoder, cutPlan,
      assets: { subtitlePath, logo: null, background: null, broll: {}, hdr: {}, scenes: {}, fonts: {}, captionFontsDirectory: fonts, captionEmoji: captions.emoji },
    } as never);
    const command = renderFfmpegArgs(await transportRenderCommand({ args: argv, directory: join(input.outDir, "work") }));
    const run = await timedFfmpeg(["-nostdin", "-hide_banner", "-loglevel", "error", ...command], 900_000);
    const glyphFailure = run.code === 0 ? captionRenderDiagnosticsFailure(classifyCaptionRenderDiagnostics(run.stderr.split(/\r?\n|\r/).filter((line) => CAPTION_RENDER_DIAGNOSTIC_PATTERN.test(line)))) : null;
    let validation = "ok";
    if (run.code !== 0 || !existsSync(outputPath)) validation = `ffmpeg exit ${run.code}: ${run.stderr.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300)}`;
    else if (glyphFailure) validation = `glyph failure ${glyphFailure.code}`;
    else {
      try {
        await validateRenderOutput({
          path: outputPath,
          expected: compositionOutputExpectation({ plan, targetId: "vertical", source: inspection, audio, hdrAssets: false }),
          workerProcess: productionWorkerProcessModule, signal, mixPeak: null,
          captionGlyphsOmitted: captions.omitted, captionEmojiSkipped: captions.emojiSkipped,
        });
      } catch (error) {
        validation = String((error as Error).message ?? error).slice(0, 300);
      }
    }
    const row: RealRenderTiming = {
      preset: name, presetId: document.captionPreset.scene ?? document.captionPreset.dynamic ?? "classic", wallSec: round(run.wall), cpuSec: round(run.user + run.sys), userSec: round(run.user), sysSec: round(run.sys),
      events: captions.ass.split("\n").filter((line) => line.startsWith("Dialogue:")).length, assBytes: Buffer.byteLength(captions.ass),
      outputBytes: existsSync(outputPath) ? (await stat(outputPath)).size : 0, exitCode: run.code, validation,
      diagnostics: run.stderr.split("\n").filter((line) => line.trim() && !/^(real|user|sys) /.test(line)).slice(0, 8),
    };
    timings.push(row);
    console.log(JSON.stringify(row));
    await writeFile(join(input.outDir, "timings.json"), `${JSON.stringify(timings, null, 2)}\n`);
  }
  return timings;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const docPath = option(args, "--doc");
  const sourcePath = option(args, "--source");
  const outDir = option(args, "--out");
  if (!docPath || !sourcePath || !outDir) throw new Error("usage: caption-scene-real-render.ts --doc <document.json> [--evidence <evidence.json>] --source <source.mp4> --out <dir> [--presets all|id,..] [--aspect 9:16]");
  const evidencePath = option(args, "--evidence");
  const requested = option(args, "--presets") ?? "all";
  const presets = requested.split(",").filter(Boolean).flatMap((name) => (name === "all" ? [...CAPTION_SCENE_NAMES, "headline", "current"] : [name]));
  await renderRealClip({
    document: JSON.parse(readFileSync(resolve(docPath), "utf8")),
    evidence: evidencePath ? JSON.parse(readFileSync(resolve(evidencePath), "utf8")) : null,
    sourcePath: resolve(sourcePath),
    outDir: resolve(outDir),
    presets,
    aspectRatio: option(args, "--aspect"),
  });
}

if (import.meta.main) await main();
