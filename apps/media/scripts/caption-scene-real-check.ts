/**
 * Frame checks of the real-clip renders (ticket 04): frame sheets, key-moment frames and ffprobe facts.
 *
 *   bun apps/media/scripts/caption-scene-real-check.ts --dir <clipDir> [--presets a,b|all] [--at 12.5,37.7] [--cols 10]
 *
 * `<clipDir>` holds `document.json`, `evidence.json`, `source.mp4` and `renders/<preset>.mp4` (written by
 * `caption-scene-real-render.ts`). For each rendered preset it writes under `<clipDir>/renders/`:
 *   <preset>-sheet.jpg            one frame every 0.5 s across the clip, row by row (`--cols` frames per row)
 *   frames/<preset>-<label>-<ms>.png   full-resolution frames at the key moments of THAT preset's own cues
 *   check.json                    cues (output time), moments, ffprobe facts against the Headline render
 * `--ink` also burns each preset's ASS over black at the render's frame rate (captions alone, a few seconds) and reads the
 * ink per frame: ink outside every cue window (a leftover after the last cue or across a cut), the first and last ink against
 * the first and last word, and words at whose start no frame inside [start - 1 frame, start + 3 frames] changed (written to
 * `<preset>-ink.json`; read the flagged ones by eye).
 * Moments: first cue entrance, first hero word, cue change, longest pause between cues, last cue's last word,
 * each speaker change, any number word, plus `--at` times. Everything stays under `out/real/` (git-ignored).
 */
import { spawnSync } from "node:child_process";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CAPTION_SCENE_NAMES } from "@narriflow/validators";
import { createRealPlanner } from "./caption-scene-real-plan";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

interface Moment {
  label: string;
  timeSec: number;
}

function probe(path: string) {
  const run = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,duration,nb_frames,sample_rate,channels,pix_fmt:format=duration", "-of", "json", path], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffprobe failed: ${run.stderr}`);
  const json = JSON.parse(run.stdout) as { streams: Array<Record<string, string>>; format: { duration: string } };
  const video = json.streams.find((stream) => stream.codec_type === "video") ?? {};
  const audio = json.streams.find((stream) => stream.codec_type === "audio") ?? {};
  return {
    video: { codec: video.codec_name, width: Number(video.width), height: Number(video.height), rate: video.r_frame_rate, frames: Number(video.nb_frames), pixFmt: video.pix_fmt, durationSec: Number(video.duration) },
    audio: { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: Number(audio.channels), durationSec: Number(audio.duration) },
    formatDurationSec: Number(json.format.duration),
  };
}

const rateOf = (rate: string) => {
  const [num, den] = rate.split("/").map(Number);
  return num! / (den || 1);
};

interface InkCue {
  cue: number;
  startSec: number;
  endSec: number;
  words: { text: string; startSec: number; endSec: number }[];
}

/** The captions alone (the preset's ASS over black at the render's frame rate), read as one ink value per frame. */
function inkTimeline(assPath: string, durationSec: number, fps: number): { ink: Float64Array; change: Float64Array } {
  const width = 270;
  const height = 480;
  const run = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=1080x1920:r=${fps}:d=${durationSec + 1}`, "-vf", `ass='${assPath}':fontsdir='${CAPTION_FONTS_DIRECTORY}',scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"],
    { maxBuffer: 1 << 30 },
  );
  if (run.status !== 0) throw new Error(`ink render failed: ${run.stderr.toString()}`);
  const data = run.stdout;
  const frameBytes = width * height;
  const frames = Math.floor(data.length / frameBytes);
  const ink = new Float64Array(frames);
  const change = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const base = frame * frameBytes;
    let max = 0;
    let diff = 0;
    for (let at = 0; at < frameBytes; at++) {
      const value = data[base + at]!;
      if (value > max) max = value;
      if (frame > 0) diff += Math.abs(value - data[base - frameBytes + at]!);
    }
    ink[frame] = max;
    change[frame] = diff / frameBytes;
  }
  return { ink, change };
}

function inkReport(assPath: string, cues: InkCue[], durationSec: number, fps: number) {
  const { ink, change } = inkTimeline(assPath, durationSec, fps);
  const frameSec = 1 / fps;
  // A frame's ink is legitimate inside a cue's window: from 1.6 s before its first word (Lyrics, Flap and Dialogue show the next
  // cue early) to the next cue's start or 650 ms after its last word (the scene cue tail), plus 0.9 s for the exit.
  const windows = cues.map((cue, index) => {
    const next = cues[index + 1];
    const stay = Math.max(cue.endSec, Math.min(cue.endSec + 0.65, next ? next.startSec : Number.POSITIVE_INFINITY));
    return { from: cue.startSec - 1.6, to: stay + 0.9 };
  });
  let firstInk = -1;
  let lastInk = -1;
  const stray: number[] = [];
  for (let frame = 0; frame < ink.length; frame++) {
    if (ink[frame]! <= 6) continue;
    const time = frame * frameSec;
    if (firstInk < 0) firstInk = time;
    lastInk = time;
    if (!windows.some((window) => time >= window.from && time <= window.to)) stray.push(Math.round(time * 1000) / 1000);
  }
  const silent: { word: string; startSec: number }[] = [];
  for (const cue of cues) {
    for (const word of cue.words) {
      const first = Math.max(1, Math.round(word.startSec * fps) - 1);
      let peak = 0;
      for (let frame = first; frame <= first + 4 && frame < change.length; frame++) peak = Math.max(peak, change[frame]!);
      if (peak < 0.02) silent.push({ word: word.text, startSec: Math.round(word.startSec * 1000) / 1000 });
    }
  }
  const firstWord = cues[0]?.words[0]?.startSec ?? 0;
  const lastCue = cues.at(-1);
  return {
    firstInkMinusFirstWordMs: firstInk < 0 ? null : Math.round((firstInk - firstWord) * 1000),
    lastInkMinusLastWordEndMs: lastInk < 0 || !lastCue ? null : Math.round((lastInk - lastCue.endSec) * 1000),
    strayInkFrames: stray.length,
    strayInkAt: stray.slice(0, 12),
    wordsWithoutChange: silent.length,
    silentWords: silent.slice(0, 20),
    inkFrames: Array.from(ink).filter((value) => value > 6).length,
    totalFrames: ink.length,
  };
}

const NUMBER_WORD = /^(\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand|million|billion|first|second|third|fourth|fifth)\W*$/i;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = resolve(option(args, "--dir") ?? "");
  if (!existsSync(join(dir, "document.json"))) throw new Error("usage: caption-scene-real-check.ts --dir <clipDir> [--presets ...] [--at t,t] [--cols N]");
  const renders = join(dir, "renders");
  const cols = Number(option(args, "--cols") ?? 10);
  const extra = (option(args, "--at") ?? "").split(",").filter(Boolean).map(Number);
  const requested = option(args, "--presets") ?? "all";
  const available = readdirSync(renders).filter((file) => file.endsWith(".mp4")).map((file) => file.replace(/\.mp4$/, ""));
  const presets = requested === "all" ? [...CAPTION_SCENE_NAMES, "headline", "current"].filter((name) => available.includes(name)) : requested.split(",");
  await mkdir(join(renders, "frames"), { recursive: true });

  const planner = await createRealPlanner({
    document: JSON.parse(readFileSync(join(dir, "document.json"), "utf8")),
    evidence: existsSync(join(dir, "evidence.json")) ? JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8")) : null,
    sourcePath: join(dir, "source.mp4"),
  });
  const reference = existsSync(join(renders, "headline.mp4")) ? probe(join(renders, "headline.mp4")) : null;
  const summary: Record<string, unknown> = {};

  for (const preset of presets) {
    const file = join(renders, `${preset}.mp4`);
    const facts = probe(file);
    const plan = planner.planPreset(preset);
    const layers = plan.targets[0]!.visualLayers.flatMap((layer) => (layer.kind === "caption" ? [layer] : []));
    const cues = layers.map((layer) => ({
      cue: layer.cueIndex,
      startSec: layer.words[0]!.startSec,
      endSec: layer.words.at(-1)!.endSec,
      activeStartSec: layer.activeRange.startSec,
      activeEndSec: layer.activeRange.endSec,
      speaker: layer.scene?.speaker ?? null,
      words: layer.words.map((word, index) => ({ text: word.text, startSec: word.startSec, endSec: word.endSec, role: layer.scene?.roles[index] ?? null })),
    }));

    const moments: Moment[] = [];
    const add = (label: string, timeSec: number) => {
      if (Number.isFinite(timeSec) && timeSec >= 0 && timeSec < facts.formatDurationSec - 0.05) moments.push({ label, timeSec: Math.round(timeSec * 1000) / 1000 });
    };
    if (cues[0]) {
      add("entrance", cues[0].startSec + 0.15);
      add("entrance-late", cues[0].startSec + 0.5);
    }
    const hero = cues.flatMap((cue) => cue.words.filter((word) => word.role === "hero"))[0];
    if (hero) add("hero", hero.startSec + 0.2);
    if (cues[2]) add("change", cues[2].startSec + 0.08);
    let gap = { size: 0.25, at: Number.NaN };
    for (let index = 1; index < cues.length; index++) {
      const size = cues[index]!.startSec - cues[index - 1]!.endSec;
      if (size > gap.size) gap = { size, at: cues[index - 1]!.endSec + size / 2 };
    }
    add("pause", gap.at);
    const last = cues.at(-1);
    if (last) add("last", last.words.at(-1)!.startSec + 0.1);
    if (last) add("after-last", last.endSec + 0.6);
    for (let index = 1; index < cues.length; index++) {
      if (cues[index]!.speaker !== cues[index - 1]!.speaker) {
        add("speaker-before", cues[index]!.startSec - 0.12);
        add("speaker", cues[index]!.startSec + 0.25);
      }
    }
    const numberCue = cues.find((cue) => cue.words.some((word) => NUMBER_WORD.test(word.text)));
    if (numberCue) add("number", numberCue.words.find((word) => NUMBER_WORD.test(word.text))!.startSec + 0.3);
    for (const time of extra) add("at", time);

    const frameDir = join(renders, "frames");
    for (const moment of moments) {
      const out = join(frameDir, `${preset}-${moment.label}-${Math.round(moment.timeSec * 1000)}.png`);
      const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(moment.timeSec), "-i", file, "-frames:v", "1", out], { encoding: "utf8" });
      if (run.status !== 0) throw new Error(`frame ${preset} ${moment.timeSec}: ${run.stderr}`);
    }
    const rows = Math.ceil(Math.ceil(facts.formatDurationSec * 2) / cols);
    const sheet = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", `fps=2,scale=216:384,tile=${cols}x${rows}:padding=2:color=0x444444`, "-frames:v", "1", "-q:v", "3", join(renders, `${preset}-sheet.jpg`)], { encoding: "utf8" });
    if (sheet.status !== 0) throw new Error(`sheet ${preset}: ${sheet.stderr}`);

    const same = reference
      ? {
          size: facts.video.width === reference.video.width && facts.video.height === reference.video.height,
          rate: facts.video.rate === reference.video.rate,
          frames: facts.video.frames === reference.video.frames,
          pixFmt: facts.video.pixFmt === reference.video.pixFmt,
          duration: Math.abs(facts.formatDurationSec - reference.formatDurationSec) < 0.05,
          audio: facts.audio.sampleRate === reference.audio.sampleRate && facts.audio.channels === reference.audio.channels && Math.abs(facts.audio.durationSec - reference.audio.durationSec) < 0.05,
        }
      : null;
    let ink: ReturnType<typeof inkReport> | null = null;
    if (args.includes("--ink")) {
      ink = inkReport(join(renders, `${preset}.ass`), cues, facts.formatDurationSec, rateOf(facts.video.rate as string));
      await writeFile(join(renders, `${preset}-ink.json`), `${JSON.stringify(ink, null, 2)}\n`);
    }
    summary[preset] = { facts, matchesHeadline: same, cues: cues.length, moments, ink };
    await writeFile(join(renders, `${preset}-cues.json`), `${JSON.stringify(cues, null, 2)}\n`);
    console.log(JSON.stringify({ preset, cues: cues.length, durationSec: facts.formatDurationSec, fps: facts.video.rate, size: `${facts.video.width}x${facts.video.height}`, matchesHeadline: same, ...(ink ? { ink: { first: ink.firstInkMinusFirstWordMs, last: ink.lastInkMinusLastWordEndMs, stray: ink.strayInkFrames, strayAt: ink.strayInkAt.slice(0, 4), silent: ink.wordsWithoutChange } } : {}), moments: moments.length }));
  }
  await writeFile(join(renders, "check.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

await main();
