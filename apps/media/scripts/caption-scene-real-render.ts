/**
 * Real-clip render of the Scene Styles through the production path (ticket 04).
 *
 *   bun apps/media/scripts/caption-scene-real-render.ts --doc <document.json> --evidence <evidence.json> \
 *     --source <source.mp4> --out <dir> [--presets all|id,id,...] [--aspect 9:16] [--emojis ai|N] [--clip start,end] \
 *     [--tone 1-5] [--add key=glyph,...]
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
 * `--emojis ai` turns caption emojis on and renders what the AI picks for the clip: the Studio route's path
 * (`suggestClipEmojis` with the real tagger at the default density), with the title and project language from `meta.json`
 * beside the document; it calls the model API (OPENAI_API_KEY from the environment, else `apps/api/.dev.vars`, never printed)
 * and writes the picks to `<dir>/emojis.json`. `--emojis N` places N test emojis, not AI picks: a fixed list cycled over words
 * spread evenly over the clip, unrelated to the words, for render benchmarks only. Either replaces the document's own
 * `studioEdits.captionEmojis`; the art is preloaded as the worker does (`loadPlanCaptionEmojiArt`). `--clip` overrides the
 * document's clip range (source seconds). The project language in `meta.json`, when present, is the plan's caption language,
 * as the render worker passes it: word classes and the hero follow it.
 * `--tone` sets the preset's Skin tone (`emojiTone`), which every emoji with skin and no tone of its own (the AI's) takes.
 * `--add` places emojis by hand after the AI's, as the picker stores them (`key` a Word Key, the glyph's design at its
 * skin-tone modifier, 0 without one): a badge or a toned emoji the clip's words do not call for, to look at it on video.
 * Output: `<dir>/<preset>.mp4`, `<dir>/<preset>.ass`, and `<dir>/timings.json` (wall and CPU seconds, events, bytes, emojis).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captionEmojiById, emojiRefForGlyph } from "@narriflow/caption-emoji/index";
import { type ClipEmojiTagger, clipEmojiWords, suggestClipEmojis } from "@narriflow/services/clip-emoji-suggestion";
import { tagCaptionEmojis } from "@narriflow/services/clip-emoji-tagging";
import {
  CAPTION_SCENE_NAMES,
  type CaptionEmojiRef,
  captionWordKey,
  DEFAULT_CAPTION_EMOJI_DENSITY,
  editorDocumentSchema,
  splitUtterancesIntoSentences,
} from "@narriflow/validators";
import { prepareCaptionFontsDirectory } from "../src/brand-font-resolution";
import { loadPlanCaptionEmojiArt } from "../src/caption-emoji-ass";
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
  emojisPlaced: number;
  emojisDropped: Record<string, number>;
}

/** Test emojis `--emojis N` cycles through (flat and many-layered designs, one with a skin tone), not AI picks. */
const REAL_RENDER_EMOJIS: readonly CaptionEmojiRef[] = [
  { id: "flame" }, { id: "heart-eyes" }, { id: "rocket" }, { id: "party" }, { id: "hundred" }, { id: "flexed-biceps", tone: 3 }, { id: "money-bag" },
  { id: "thumbs-up" }, { id: "sparkles" }, { id: "brain" }, { id: "astronaut" }, { id: "star-struck" }, { id: "laugh-tears" }, { id: "crown" },
];

/**
 * The document with caption emojis on and `count` test emojis (not AI picks) anchored on words spread evenly over the clip's
 * kept words (Word Keys are source ms); `clip` overrides its range.
 */
export function withRealRenderEmojis(document: unknown, count: number, clip?: { startSec: number; endSec: number }): unknown {
  const doc = structuredClone(document) as {
    clipStartSec: number; clipEndSec: number; deletedRanges: { startSec: number; endSec: number }[];
    captionPreset: Record<string, unknown>; studioEdits: Record<string, unknown>;
    transcriptSlice: { words?: { startSec: number; endSec: number }[] }[];
  };
  if (clip) Object.assign(doc, { clipStartSec: clip.startSec, clipEndSec: clip.endSec, deletedRanges: doc.deletedRanges.filter((range) => range.startSec >= clip.startSec && range.endSec <= clip.endSec) });
  const kept = doc.transcriptSlice.flatMap((utterance) => utterance.words ?? []).filter((word) =>
    word.startSec >= doc.clipStartSec && word.endSec <= doc.clipEndSec && !doc.deletedRanges.some((range) => word.startSec < range.endSec && word.endSec > range.startSec));
  const emojis: Record<string, CaptionEmojiRef> = {};
  for (let at = 0; at < Math.min(count, kept.length); at++) {
    const word = kept[Math.floor(((at + 0.5) * kept.length) / count)]!;
    emojis[String(Math.round(word.startSec * 1000))] = REAL_RENDER_EMOJIS[at % REAL_RENDER_EMOJIS.length]!;
  }
  doc.captionPreset = { ...doc.captionPreset, emojis: count > 0 };
  const { captionEmojis: _replaced, ...edits } = doc.studioEdits;
  doc.studioEdits = count > 0 ? { ...edits, captionEmojis: emojis } : edits;
  return doc;
}

/** One AI pick as rendered: its word, sentence, emoji and strength, and the word's start in the clip's edited time. */
export interface RealRenderAiPick {
  key: string;
  word: string;
  sentence: string;
  id: string;
  glyph: string;
  name: string;
  strength: number;
  editedStartSec: number;
}

/** OPENAI_API_KEY from the environment, else from the API's local env file. Never logged. */
function openAiKey(): string {
  const fromEnv = process.env.OPENAI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = fileURLToPath(new URL("../../api/.dev.vars", import.meta.url));
  const line = existsSync(file) ? /^OPENAI_API_KEY=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1] : undefined;
  return line?.trim().replace(/^["']|["']$/g, "") ?? "";
}

/**
 * The document with caption emojis on and the AI's picks for it, as the Studio's Add with AI stores them: `suggestClipEmojis`
 * with the real tagger at `DEFAULT_CAPTION_EMOJI_DENSITY`. `meta` gives the clip title and the project language.
 */
export async function withAiEmojis(document: unknown, meta: { title?: string | null; project?: { languageCode?: string | null } } | null): Promise<{ document: unknown; picks: RealRenderAiPick[] }> {
  const apiKey = openAiKey();
  if (!apiKey) throw new Error("--emojis ai needs OPENAI_API_KEY (environment or apps/api/.dev.vars)");
  const doc = editorDocumentSchema.parse(document);
  const tagger: ClipEmojiTagger = (input) => tagCaptionEmojis(input, { apiKey });
  const suggestion = await suggestClipEmojis({ document: doc, languageCode: meta?.project?.languageCode ?? null, title: meta?.title ?? null, density: DEFAULT_CAPTION_EMOJI_DENSITY, deadline: Date.now() + 60_000 }, tagger);
  if (!suggestion.complete) throw new Error(`the tagger did not finish: ${JSON.stringify(suggestion.outcome)}`);
  const { words } = clipEmojiWords(doc);
  const editedStart = new Map(words.map((word) => [word.key, word.editedStartSec]));
  const sentences = splitUtterancesIntoSentences(doc.transcriptSlice);
  const picks = Object.entries(suggestion.emojis).map(([key, ref]): RealRenderAiPick => {
    const sentence = sentences.find((each) => each.words.some((word) => captionWordKey(word.startSec) === key));
    const word = sentence?.words.find((each) => captionWordKey(each.startSec) === key);
    const entry = captionEmojiById(ref.id)!;
    const strength = suggestion.outcome?.picks.find((pick) => pick.key === key)?.strength ?? 0;
    return { key, word: word?.word ?? "", sentence: sentence?.words.map((each) => each.word).join(" ") ?? "", id: entry.id, glyph: entry.glyph, name: entry.name, strength, editedStartSec: editedStart.get(key) ?? Number.NaN };
  });
  return { document: { ...doc, captionPreset: { ...doc.captionPreset, emojis: true }, studioEdits: { ...doc.studioEdits, captionEmojis: suggestion.emojis } }, picks };
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
  captionLanguage?: string | null;
  signal?: AbortSignal;
}): Promise<RealRenderTiming[]> {
  const signal = input.signal ?? new AbortController().signal;
  await mkdir(join(input.outDir, "work"), { recursive: true });
  const planner = await createRealPlanner({ document: input.document, evidence: input.evidence, sourcePath: input.sourcePath, aspectRatio: input.aspectRatio, captionLanguage: input.captionLanguage, signal });
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
    const track = compileCompositionPlanCaptions(plan, "vertical", new Map(), undefined, captionFps, await loadPlanCaptionEmojiArt(plan));
    const captions = name === "none" ? { ...track, ass: track.ass.split("\n").filter((line) => !line.startsWith("Dialogue:")).join("\n") } : track;
    const subtitlePath = join(input.outDir, `${name}.ass`);
    await writeFile(subtitlePath, captions.ass, "utf8");
    const outputPath = join(input.outDir, `${name}.mp4`);
    await rm(outputPath, { force: true });
    const argv = compileClipCompositionCommand({
      sourcePath: input.sourcePath, outputPath, startSec: document.clipStartSec, endSec: document.clipEndSec, source: inspection, plan, targetId: "vertical",
      audio, encoder, cutPlan,
      assets: { subtitlePath, logo: null, background: null, broll: {}, hdr: {}, scenes: {}, fonts: {}, captionFontsDirectory: fonts },
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
          captionGlyphsOmitted: captions.omitted,
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
      emojisPlaced: captions.emojis.placed, emojisDropped: { ...captions.emojis.dropped },
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
  if (!docPath || !sourcePath || !outDir) throw new Error("usage: caption-scene-real-render.ts --doc <document.json> [--evidence <evidence.json>] --source <source.mp4> --out <dir> [--presets all|id,..] [--aspect 9:16] [--emojis ai|N (N test emojis, not AI)] [--clip start,end]");
  const evidencePath = option(args, "--evidence");
  const requested = option(args, "--presets") ?? "all";
  const presets = requested.split(",").filter(Boolean).flatMap((name) => (name === "all" ? [...CAPTION_SCENE_NAMES, "headline", "current"] : [name]));
  const emojiOption = option(args, "--emojis");
  const emojis = emojiOption === "ai" ? 0 : Number(emojiOption ?? 0);
  const clip = option(args, "--clip")?.split(",").map(Number);
  let document = JSON.parse(readFileSync(resolve(docPath), "utf8"));
  if (emojis > 0 || clip) document = withRealRenderEmojis(document, emojis, clip ? { startSec: clip[0]!, endSec: clip[1]! } : undefined);
  const metaPath = join(dirname(resolve(docPath)), "meta.json");
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
  if (emojiOption === "ai") {
    const ai = await withAiEmojis(document, meta);
    document = ai.document;
    await mkdir(resolve(outDir), { recursive: true });
    await writeFile(join(resolve(outDir), "emojis.json"), `${JSON.stringify(ai.picks, null, 2)}\n`);
  }
  const tone = option(args, "--tone");
  const added = option(args, "--add")?.split(",").filter(Boolean) ?? [];
  if (tone || added.length > 0) {
    const doc = editorDocumentSchema.parse(document);
    const hand = Object.fromEntries(added.map((item) => {
      const [key, glyph] = item.split("=") as [string, string];
      const ref = emojiRefForGlyph(glyph);
      if (!ref) throw new Error(`--add: no design for ${glyph}`);
      return [key, captionEmojiById(ref.id)!.hasTones ? { id: ref.id, tone: ref.tone ?? 0 } : { id: ref.id }];
    }));
    document = { ...doc, captionPreset: { ...doc.captionPreset, emojis: true, ...(tone ? { emojiTone: Number(tone) } : {}) }, studioEdits: { ...doc.studioEdits, captionEmojis: { ...doc.studioEdits.captionEmojis, ...hand } } };
  }
  await renderRealClip({
    document,
    evidence: evidencePath ? JSON.parse(readFileSync(resolve(evidencePath), "utf8")) : null,
    sourcePath: resolve(sourcePath),
    outDir: resolve(outDir),
    presets,
    aspectRatio: option(args, "--aspect"),
    captionLanguage: meta?.project?.languageCode ?? null,
  });
}

if (import.meta.main) await main();
