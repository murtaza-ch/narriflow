/**
 * Golden caption frames (ticket 10): serializes cues with `renderCaptionTrack`
 * and burns them with the real ffmpeg/libass over a flat background, so the
 * pills, plates and word order of every script can be looked at.
 *
 *   bun apps/worker/scripts/caption-frames.ts <outputDirectory> [caseId...]
 *
 * Each case writes `<id>.png` (one frame, cropped around the caption) and
 * `<id>.ass`. The frame is taken while the second word is active.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import { getCaptionPresetById } from "@narriflow/validators";
import { renderCaptionTrack } from "../src/caption-ass";

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

const CANVAS = { width: 1080, height: 1920 } as const;
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

const [output, ...only] = process.argv.slice(2);
if (!output) throw new Error("usage: caption-frames.ts <outputDirectory> [caseId...]");
mkdirSync(output, { recursive: true });
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
