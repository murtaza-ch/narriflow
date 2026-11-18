/**
 * Throwaway look proof (ticket 02). Writes, next to this file:
 *  - headline.ass  Headline cues, one event per word per paint layer, phase 2 gradient bands
 *  - boldpop.ass   the same words through the real `renderCaptionTrack` with Bold Pop (budget baseline)
 *  - cues.json     cue data plus the HarfBuzz geometry, which headline.html checks its Canvas layout against
 *
 *   bun .scratch/dynamic-captions/references/proof/build.ts        (from the worktree root)
 *   bun .scratch/dynamic-captions/references/proof/build.ts 80 1   (variant: S = 80, minor = 1 em; headline-s80.ass only)
 *
 * Word measurement uses `layoutCaptionLine` (HarfBuzz, the worker's method). Placement comes from
 * ./layout.js, shared with headline.html. Not engine code.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { layoutCaptionLine } from "../../../../packages/caption-fonts/src/shaping.ts";
import { captionFontFace } from "../../../../packages/validators/src/caption-font.ts";
import { getCaptionPresetById } from "../../../../packages/validators/src/index.ts";
import { renderCaptionTrack } from "../../../../apps/media/src/caption-ass.ts";
import { ANCHOR, CANVAS, EASE_OUT_ACCEL, HEADLINE, SLIDE, entranceScale, fnv1a, layoutCue } from "./layout.js";

const HERE = import.meta.dir;
// Comparison variant for G2 (hierarchy closer to reference 01): `build.ts 80 1` (S, minor size in em) writes headline-s80.ass only.
const [variantS, variantMinorEm] = Bun.argv.slice(2);
const VARIANT = variantS ? `-s${variantS}` : "";
if (variantS) {
  HEADLINE.S = Number(variantS);
  HEADLINE.roles.minor.sizeEm = Number(variantMinorEm ?? HEADLINE.roles.minor.sizeEm);
}
const FONTS = join(HERE, "../../../../packages/caption-fonts/fonts");
const FACES = { text: captionFontFace("Inter SemiBold"), hero: captionFontFace("Inter") } as const;
type Font = keyof typeof FACES;

/** libass `\blur` strength per unit of Gaussian sigma (caption-ass.ts `ASS_BLUR_PER_SIGMA`). */
const ASS_BLUR_PER_SIGMA = 1 / 0.849;
const BAND_MAX_PX = 8;
const BAND_MAX_COUNT = 32;
const CUE_PITCH_SEC = 1.65;
const CUE_LENGTH_SEC = 1.6;

type Role = "minor" | "body" | "hero";
/** [text, role, onset in s from the cue start] */
const CUES: readonly (readonly [string, Role, number])[][] = [
  [["with", "minor", 0], ["Accurate", "hero", 0.25], ["captions", "body", 0.75]],
  [["the", "minor", 0], ["BEST", "hero", 0.2], ["part", "body", 0.6]],
  [["I", "minor", 0], ["made", "body", 0.15], ["20", "hero", 0.45], ["dollars", "hero", 0.7]],
  [["This", "minor", 0], ["is", "minor", 0.15], ["96%", "hero", 0.35], ["accurate", "body", 0.8]],
  [["if", "minor", 0], ["it", "minor", 0.1], ["has", "minor", 0.2], ["Captions", "hero", 0.4]],
  [["apni", "body", 0], ["Language", "hero", 0.3], ["mein", "minor", 0.8], ["likho", "body", 1.0]],
  [["you", "minor", 0], ["will", "minor", 0.12], ["never", "hero", 0.3], ["guess", "body", 0.75]],
  [["the", "minor", 0], ["secret", "body", 0.12], ["is", "minor", 0.4], ["consistency", "hero", 0.55]],
  [["got", "body", 0], ["1", "hero", 0.25], ["million", "hero", 0.4], ["views", "body", 0.85]],
  [["stop", "body", 0], ["wasting", "hero", 0.3], ["your", "minor", 0.8], ["time", "body", 0.95]],
  [["it", "minor", 0], ["changed", "body", 0.15], ["everything", "hero", 0.45]],
  [["this", "minor", 0], ["is", "minor", 0.15], ["HUGE", "hero", 0.35]],
];

interface Measured { advanceEm: number; inkTopEm: number; inkBottomEm: number; bboxCenterEm: number }
const cache = new Map<string, Measured>();
function measure(text: string, font: Font): Measured {
  const key = `${font}\0${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const line = layoutCaptionLine(
    [{ parts: [{ text, fontPath: join(FONTS, FACES[font].file), spaced: true, inked: true }], gap: null, gapExtraEm: 0 }],
    0,
    "ltr",
  );
  const value = { advanceEm: line.widthEm, inkTopEm: line.inkTopEm, inkBottomEm: line.inkBottomEm, bboxCenterEm: line.bboxCenterEm };
  cache.set(key, value);
  return value;
}

const num = (value: number) => String(Math.round(value * 100) / 100);
const alphaByte = (opacity: number) => Math.round((1 - opacity) * 255);
const hex2 = (value: number) => value.toString(16).padStart(2, "0").toUpperCase();
const assColor = (hex: string) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
function mix(top: string, bottom: string, t: number): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5].map((at) => hex2(Math.round(channel(top, at) + (channel(bottom, at) - channel(top, at)) * t))).join("")}`;
}
function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, "0")}:${String(Math.floor((cs % 6000) / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

interface Event { layer: number; start: number; end: number; text: string }
const events: Event[] = [];
const summary: unknown[] = [];

CUES.forEach((spec, cueIndex) => {
  const cueStart = cueIndex * CUE_PITCH_SEC;
  const cueEnd = cueStart + CUE_LENGTH_SEC;
  const words = spec.map(([text, role, onset]) => ({ text, role, startSec: cueStart + onset }));
  const seed = fnv1a(String(Math.round(words[0]!.startSec * 1000)));
  const layout = layoutCue({ words, endSec: cueEnd, seed }, measure);
  const heroWords = layout.words.filter((word) => word.role === "hero");
  const heroInk = heroWords.length > 0
    ? { top: Math.min(...heroWords.map((word) => word.baselineY - word.inkTop)), bottom: Math.max(...heroWords.map((word) => word.baselineY + word.inkBottom)) }
    : null;
  const before = events.length;
  let bandCount = 0;

  for (const word of layout.words) {
    const face = FACES[word.font as Font];
    const m = measure(word.text, word.font as Font);
    const px = word.px;
    const s = px / HEADLINE.S;
    // libass centres an `\an5` event on its own bbox and line box; aim that at the layout's advance box and baseline.
    const x = word.centerX + (m.bboxCenterEm - m.advanceEm / 2) * px;
    const y = word.baselineY - ((face.ascent - face.descent) / 2) * px;
    const remainingMs = (cueEnd - word.startSec) * 1000;
    const hero = word.role === "hero";
    const k = entranceScale(remainingMs, hero ? SLIDE.hero.travelMs : SLIDE.word.travelMs);
    const durMs = Math.round(remainingMs);
    const head = `\\an5\\fn${face.assName}\\fs${num(px * (face.ascent + face.descent))}\\bord0\\shad0`;
    const at = (ms: number) => Math.round(ms * k);

    const position = (offsetY: number) => {
      const ox = x;
      const oy = y + offsetY;
      if (k === 0) return `\\pos(${num(ox)},${num(oy)})\\org(${num(x)},${num(y)})`;
      const fromX = hero ? ox : ox + SLIDE.word.offsetXEm * px * word.motionSign;
      const fromY = hero ? oy + SLIDE.hero.offsetYEm * px : oy;
      return `\\move(${num(fromX)},${num(fromY)},${num(ox)},${num(oy)},0,${at(SLIDE[hero ? "hero" : "word"].travelMs)})\\org(${num(x)},${num(y)})`;
    };
    const blur = (layerSigma: number) => {
      const b = (sigma: number) => num(sigma * ASS_BLUR_PER_SIGMA);
      if (!hero || k === 0) return layerSigma > 0 ? `\\blur${b(layerSigma)}` : "";
      return `\\blur${b(SLIDE.hero.blurEm * px + layerSigma)}\\t(0,${at(SLIDE.hero.blurMs)},${EASE_OUT_ACCEL},\\blur${b(layerSigma)})`;
    };
    const fade = k === 0 ? "" : `\\fade(255,0,0,0,${at(SLIDE[hero ? "hero" : "word"].opacityMs)},${durMs},${durMs})`;
    const push = (layer: number, tags: string) =>
      events.push({ layer, start: word.startSec, end: cueEnd, text: `{${tags}}${word.text}` });

    // Shadow: black 65%, CSS 6 px blur (sigma 3), 2 px down, scaled by the word's size relative to S.
    const shadow = HEADLINE.shadow;
    push(0, `${head}${position(shadow.offsetYPx * s)}\\1c${assColor(shadow.color)}\\1a&H${hex2(alphaByte(shadow.opacity))}&${blur((shadow.blurPx / 2) * s)}${fade}`);

    if (!hero || !heroInk) {
      push(1, `${head}${position(0)}\\1c&HFFFFFF&${blur(0)}${fade}`);
      continue;
    }
    // Gradient: horizontal \clip bands over the hero row's ink plus entrance travel and blur spill.
    // Band edges sit on even rows: the ass filter blends into 4:2:0 frames, and a band edge on an odd row
    // makes both bands half-cover one chroma sample, which leaks the background's chroma as a grey seam.
    const spill = 2 * SLIDE.hero.blurEm * px;
    const top = 2 * Math.floor((heroInk.top - spill) / 2);
    const span = heroInk.bottom + SLIDE.hero.offsetYEm * px + spill - top;
    const count = Math.min(BAND_MAX_COUNT, Math.ceil(span / BAND_MAX_PX));
    const height = 2 * Math.ceil(span / count / 2);
    bandCount += count;
    for (let band = 0; band < count; band++) {
      const y0 = top + band * height;
      const y1 = y0 + height;
      const t = Math.min(1, Math.max(0, ((y0 + y1) / 2 - heroInk.top) / (heroInk.bottom - heroInk.top)));
      const color = mix(HEADLINE.gradient.top, HEADLINE.gradient.bottom, t);
      push(1, `${head}${position(0)}\\1c${assColor(color)}${blur(0)}${fade}\\clip(0,${y0},${CANVAS.width},${y1})`);
    }
  }
  summary.push({
    startSec: cueStart,
    endSec: cueEnd,
    seed,
    text: words.map((word) => word.text).join(" "),
    events: events.length - before,
    bands: bandCount,
    scale: layout.scale,
    inkGapsPx: layout.inkGaps,
    words: layout.words.map((word) => ({
      text: word.text, role: word.role, font: word.font, startSec: word.startSec, px: word.px,
      baselineX: word.baselineX, baselineY: word.baselineY, advance: word.advance, inkTop: word.inkTop, inkBottom: word.inkBottom, motionSign: word.motionSign,
    })),
  });
});

const ass = [
  "[Script Info]",
  "; Throwaway look proof, ticket 02: Headline (phase 2 gradient). Generated by build.ts.",
  "ScriptType: v4.00+",
  `PlayResX: ${CANVAS.width}`,
  `PlayResY: ${CANVAS.height}`,
  "WrapStyle: 2",
  "ScaledBorderAndShadow: yes",
  // libass does not kern unless asked; HarfBuzz measurement and CSS do. Without this, "Ac" sits 6 px wider here.
  "Kerning: yes",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  `Style: Word,${FACES.text.assName},80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ...events.map((event) => `Dialogue: ${event.layer},${assTime(event.start)},${assTime(event.end)},Word,,0,0,0,,${event.text}`),
  "",
].join("\n");
writeFileSync(join(HERE, `headline${VARIANT}.ass`), ass);
if (VARIANT) process.exit(0);

// Bold Pop baseline: the same words and timings through the real classic painter.
const boldPop = getCaptionPresetById("bold-pop")!.preset;
const layers = CUES.map((spec, cueIndex) => {
  const cueStart = cueIndex * CUE_PITCH_SEC;
  const cueEnd = cueStart + CUE_LENGTH_SEC;
  const words = spec.map(([text, , onset], index) => ({
    text: text.toUpperCase(),
    emoji: null,
    startSec: cueStart + onset,
    endSec: index + 1 < spec.length ? cueStart + spec[index + 1]![2] : cueEnd,
  }));
  return {
    id: `caption:${cueIndex}`,
    kind: "caption" as const,
    cueIndex,
    activeRange: { startSec: cueStart, endSec: cueEnd },
    anchor: { xPct: ANCHOR.xPct, yPct: ANCHOR.yPct },
    destination: { x: 0, y: 0, width: CANVAS.width, height: CANVAS.height },
    rotationDeg: 0,
    opacity: 1,
    zIndex: 40,
    preset: boldPop,
    words,
    language: "en",
  };
});
const track = renderCaptionTrack({ layers, canvas: CANVAS });
writeFileSync(join(HERE, "boldpop.ass"), track.ass);
const boldPopDialogues = track.ass.split("\n").filter((line) => line.startsWith("Dialogue:")).length;

writeFileSync(join(HERE, "cues.json"), `${JSON.stringify({ canvas: CANVAS, anchor: ANCHOR, cues: summary }, null, 1)}\n`);
const perCue = (summary as { events: number; bands: number; text: string; inkGapsPx: number[]; scale: number }[]);
for (const cue of perCue) console.log(`${cue.text.padEnd(28)} events ${String(cue.events).padStart(3)}  bands ${String(cue.bands).padStart(2)}  scale ${cue.scale.toFixed(3)}  ink gaps ${cue.inkGapsPx.map((gap) => gap.toFixed(2)).join(", ")}`);
console.log(`Headline: ${events.length} Dialogue events over ${CUES.length} cues (max ${Math.max(...perCue.map((cue) => cue.events))} per cue)`);
console.log(`Bold Pop: ${boldPopDialogues} Dialogue events over ${CUES.length} cues`);
