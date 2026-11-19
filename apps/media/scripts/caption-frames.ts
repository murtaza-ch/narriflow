/**
 * Golden caption frames (ticket 10): serializes cues with `renderCaptionTrack`
 * and burns them with the real ffmpeg/libass, so the pills, plates and word
 * order of every script, and the Caption Blocks of Dynamic Styles, can be
 * looked at.
 *
 *   bun apps/media/scripts/caption-frames.ts <outputDirectory> [caseId...]
 *
 * Classic cases (below) write `<id>.png`, one frame cropped around the caption
 * over a flat background while the second word is active, and `<id>.ass`.
 *
 * Dynamic caption cases come from the fixture manifest
 * (`packages/composition-plan/src/__fixtures__/dynamic-captions/manifest.json`,
 * spec section 9), planned through the real composition plan. Each writes
 * `<id>.ass` and, in `<id>/`, full 1080x1920 frames over the three pinned
 * backgrounds (dark, bright, busy) at onset - 1 frame, onset, +33, +100 and
 * +200 ms, settled, and cue end - 1 frame, on the 30 fps grid
 * (`<background>-<moment>.jpg`), plus `frames.json` with the exact times so the
 * Studio frames can be taken at the same moments. Onset is the cue's first
 * spoken word; settled is the first frame after every entrance has finished.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import {
  CAPTION_MOTIONS,
  captionBlockAnimation,
  captionDynamicStyle,
  captionEntranceKeyframes,
  captionEntranceMs,
  getCaptionPresetById,
} from "@narriflow/validators";
import { captionBlockGeometry, renderCaptionTrack } from "../src/caption-ass";
import {
  DYNAMIC_CAPTION_BACKGROUNDS,
  type DynamicCaptionFixture,
  dynamicCaptionBackgroundPath,
  dynamicCaptionFixtures,
  dynamicCaptionLayers,
  CANVAS,
} from "./dynamic-caption-fixtures";

interface FrameCase {
  readonly id: string;
  readonly language: string | null;
  readonly preset: string;
  readonly words: readonly string[];
  readonly yPct?: number;
  /** `false`: the provider put no space before this word (index into words). */
  readonly abutting?: readonly number[];
  readonly active?: number;
}

const CASES: readonly FrameCase[] = [
  { id: "ur-nastaliq-bottom", language: "ur", preset: "electric", words: ["پاکستان", "میں", "مُحَبَّتُوں", "کی", "زبان"], yPct: 78 },
  { id: "ur-nastaliq-top", language: "ur", preset: "electric", words: ["پاکستان", "میں", "مُحَبَّتُوں", "کی", "زبان"], yPct: 12 },
  { id: "ur-long-word", language: "ur", preset: "electric", words: ["مُحَبَّتُوں", "اُردُو", "اِنتِہائی", "خُوبصُورَت"], yPct: 60, active: 2 },
  { id: "ur-short-word", language: "ur", preset: "electric", words: ["پاکستان", "میں", "کی", "زبان"], yPct: 60, active: 2 },
  { id: "ar-harakat", language: "ar", preset: "electric", words: ["مَرْحَبًا", "بِالْعَالَمِ", "جَمِيلٌ"], yPct: 60 },
  { id: "ur-generic-arabic-face", language: null, preset: "electric", words: ["پاکستان", "میں", "مُحَبَّتُوں", "کی", "زبان"], yPct: 78 },
  { id: "ar-numbers-latin", language: "ar", preset: "electric", words: ["مرحبا", "بالعالم", "2026", "Narriflow", "رائع"], yPct: 70 },
  { id: "ar-karaoke", language: "ar", preset: "karaoke", words: ["مرحبا", "بالعالم", "في", "ناريفلو"], yPct: 70 },
  { id: "ar-typewriter", language: "ar", preset: "typewriter", words: ["مرحبا", "بالعالم", "في", "ناريفلو"], yPct: 70 },
  { id: "he", language: "he", preset: "electric", words: ["שלום", "עולם", "טוב", "מאוד"], yPct: 70 },
  { id: "hi-conjuncts", language: "hi", preset: "electric", words: ["क्षत्रिय", "विद्यार्थी", "श्रीमान", "हैं"], yPct: 70 },
  { id: "bn", language: "bn", preset: "electric", words: ["বাংলাদেশ", "স্বাধীনতা", "দিবস", "শুভ"], yPct: 70 },
  { id: "ta", language: "ta", preset: "electric", words: ["தமிழ்", "மொழி", "இனிமை", "வணக்கம்"], yPct: 70 },
  { id: "th", language: "th", preset: "electric", words: ["สวัสดี", "ครับ", "ทุกคน", "ที่น่ารัก"], yPct: 70 },
  { id: "ja", language: "ja", preset: "electric", words: ["今日", "は", "いい", "天気", "です", "ね"], abutting: [1, 2, 3, 4, 5], yPct: 70, active: 1 },
  { id: "ja-generic-han", language: "zh", preset: "electric", words: ["今日", "は", "いい", "天気", "です", "ね"], abutting: [1, 2, 3, 4, 5], yPct: 70, active: 1 },
  { id: "yue", language: "yue", preset: "electric", words: ["我", "哋", "今", "日", "去", "邊", "度"], abutting: [1, 2, 3, 4, 5, 6], yPct: 70, active: 1 },
  { id: "am", language: "am", preset: "electric", words: ["ሰላም", "ለዓለም", "አማርኛ", "ቋንቋ"], yPct: 70 },
  { id: "ka", language: "ka", preset: "electric", words: ["გამარჯობა", "მსოფლიო", "ქართული", "ენა"], yPct: 70 },
  { id: "en-pill", language: "en", preset: "electric", words: ["READY", "TO", "GO", "NOW"], yPct: 70 },
];

const ACTIVE_OFFSET_SEC = 0.25;

function layer(frame: FrameCase): CompositionCaptionVisualLayer {
  const preset = getCaptionPresetById(frame.preset)!.preset;
  const words = frame.words.map((text, index) => ({
    text,
    emoji: null,
    startSec: index * 0.5,
    endSec: (index + 1) * 0.5,
    ...(frame.abutting?.includes(index) ? { spaceBefore: false } : {}),
  }));
  return {
    id: "caption:0",
    kind: "caption",
    cueIndex: 0,
    activeRange: { startSec: 0, endSec: words.length * 0.5 },
    anchor: { xPct: 50, yPct: frame.yPct ?? 70 },
    destination: { x: 0, y: 0, width: CANVAS.width, height: CANVAS.height },
    rotationDeg: 0,
    opacity: 1,
    zIndex: 40,
    preset,
    words,
    language: frame.language,
  };
}

const FPS = 30;

/** When every word of the cue has finished its entrance (the shared duration cap included), in seconds. */
function settledSec(cue: CompositionCaptionVisualLayer): number {
  const end = cue.activeRange.endSec;
  if (!cue.block) return Math.min(end, (cue.words[cue.words.length - 1]?.startSec ?? cue.activeRange.startSec) + 0.3);
  const { layout } = captionBlockGeometry({ cue: { ...cue, block: cue.block }, canvas: CANVAS });
  const motion = CAPTION_MOTIONS[captionBlockAnimation(cue.preset, captionDynamicStyle(cue.block.style))];
  return Math.max(
    ...cue.words.map((word, index) => {
      const entranceMs = captionEntranceMs(captionEntranceKeyframes(motion, cue.block!.roles[index] === "hero"));
      return word.startSec + (layout.words[index]!.entranceTimeScale * entranceMs) / 1000;
    }),
  );
}

/**
 * The spec section 9 moments of a cue on the 30 fps grid. Onset is the first frame at or after the
 * cue's first spoken word; +33, +100 and +200 ms are 1, 3 and 6 frames after it.
 */
function cueMoments(cue: CompositionCaptionVisualLayer): { name: string; frame: number; sec: number }[] {
  const atOrAfter = (sec: number) => Math.ceil(sec * FPS - 1e-6);
  const onset = atOrAfter(cue.activeRange.startSec);
  const last = atOrAfter(cue.activeRange.endSec) - 1;
  const frames: [string, number][] = [
    ["onset-1f", onset - 1],
    ["onset", onset],
    ["onset+33ms", onset + 1],
    ["onset+100ms", onset + 3],
    ["onset+200ms", onset + 6],
    ["settled", Math.min(last, atOrAfter(settledSec(cue)))],
    ["end-1f", last],
  ];
  return frames.map(([name, frame]) => ({ name, frame, sec: frame / FPS }));
}

function renderDynamicCase(output: string, fixture: DynamicCaptionFixture) {
  const layers = dynamicCaptionLayers(fixture);
  const track = renderCaptionTrack({ layers, canvas: CANVAS });
  const ass = join(output, `${fixture.id}.ass`);
  writeFileSync(ass, track.ass);
  const directory = join(output, fixture.id);
  mkdirSync(directory, { recursive: true });
  const dialogues = track.ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  const cues = layers.map((cue) => ({
    cueIndex: cue.cueIndex,
    text: cue.words.map((word) => word.text).join(" "),
    activeRange: cue.activeRange,
    // Events start at a word's onset and end at the cue's end, so a cue's events lie inside its range.
    events: dialogues.filter((line) => {
      const [, start, end] = line.split(",");
      const seconds = (time: string) => time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
      return seconds(start!) >= Math.round(cue.activeRange.startSec * 100) / 100 && seconds(end!) <= Math.round(cue.activeRange.endSec * 100) / 100;
    }).length,
    moments: cueMoments(cue),
  }));
  for (const cue of cues) {
    for (const background of DYNAMIC_CAPTION_BACKGROUNDS) {
      for (const moment of cue.moments) {
        const jpg = join(directory, `${cues.length > 1 ? `cue${cue.cueIndex}-` : ""}${background}-${moment.name}.jpg`);
        const run = spawnSync(
          "ffmpeg",
          [
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", dynamicCaptionBackgroundPath(background),
            "-vf", `scale=${CANVAS.width}:${CANVAS.height}:flags=lanczos,settb=1/1000000,setpts=${moment.sec}/TB,ass='${ass}':fontsdir='${CAPTION_FONTS_DIRECTORY}'`,
            "-frames:v", "1", "-q:v", "3", jpg,
          ],
          { encoding: "utf8" },
        );
        if (run.status !== 0) throw new Error(`ffmpeg failed for ${fixture.id} ${background} ${moment.name}: ${run.stderr}`);
      }
    }
  }
  writeFileSync(join(directory, "frames.json"), `${JSON.stringify({ id: fixture.id, fps: FPS, backgrounds: DYNAMIC_CAPTION_BACKGROUNDS, cues }, null, 2)}\n`);
  if (track.geometryUnavailable.length > 0) console.warn(`${fixture.id}: geometry unavailable`, track.geometryUnavailable);
  if (track.omitted.length > 0) console.warn(`${fixture.id}: omitted`, track.omitted);
  console.log(`${fixture.id}: ${directory} (${cues.map((cue) => `cue ${cue.cueIndex}: ${cue.events} events`).join(", ")})`);
}

const [output, ...only] = process.argv.slice(2);
if (!output) throw new Error("usage: caption-frames.ts <outputDirectory> [caseId...]");
mkdirSync(output, { recursive: true });
const fixtures = dynamicCaptionFixtures();
const known = new Set([...CASES.map((frame) => frame.id), ...fixtures.map((fixture) => fixture.id)]);
const unknown = only.filter((id) => !known.has(id));
if (unknown.length > 0) throw new Error(`unknown case: ${unknown.join(", ")}`);
for (const fixture of fixtures.filter((candidate) => only.length === 0 || only.includes(candidate.id))) {
  renderDynamicCase(output, fixture);
}
for (const frame of CASES.filter((candidate) => only.length === 0 || only.includes(candidate.id))) {
  const cue = layer(frame);
  const track = renderCaptionTrack({ layers: [cue], canvas: CANVAS });
  const ass = join(output, `${frame.id}.ass`);
  writeFileSync(ass, track.ass);
  const active = frame.active ?? 1;
  const at = active * 0.5 + ACTIVE_OFFSET_SEC;
  const centerY = Math.round((cue.anchor.yPct / 100) * CANVAS.height);
  const top = Math.max(0, Math.min(CANVAS.height - 560, centerY - 280));
  const png = join(output, `${frame.id}.png`);
  const run = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=0x2b3040:s=${CANVAS.width}x${CANVAS.height}:d=${cue.activeRange.endSec}:r=30`,
      "-vf", `ass='${ass}':fontsdir='${CAPTION_FONTS_DIRECTORY}',crop=${CANVAS.width}:560:0:${top}`,
      "-ss", String(at), "-frames:v", "1", png,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`ffmpeg failed for ${frame.id}: ${run.stderr}`);
  if (track.geometryUnavailable.length > 0) console.warn(`${frame.id}: geometry unavailable`, track.geometryUnavailable);
  if (track.omitted.length > 0) console.warn(`${frame.id}: omitted`, track.omitted);
  console.log(`${frame.id}: ${png}`);
}
