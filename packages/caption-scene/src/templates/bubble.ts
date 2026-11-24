import { toCaptionUpperCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, lerp, prog } from "../ease";
import { SCENE_DEFAULT_FPS, paintedFrameCount, sceneSampleRate } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, sceneSpace } from "../layout";
import { type Box, type Clip, type Piece, type ShapePiece, type TextPiece, type Track, mixColour, pieceBounds } from "../scene";
import { ellipsePath, polygonPath, roundedRectPath, sparklePath } from "../shapes";
import { hasTwoPaintedFrames, speechLaneSpace, speechWindows } from "./speech-layout";

/**
 * Bubble (`samples/templates/m28-bubbles.js`, the sample's "Neon"; the classic `neon` preset owns that id and name): the spoken
 * line is plain heavy Rubik with a soft dark shadow; the reaction word is pulled out into a neon-tube speech bubble above it, a
 * fat coloured tube with a thin bright core over a glow, drawn on in two wipes (across the top, back along the bottom) with the
 * word typed inside. Three bubble shapes (a wobbly ellipse, a starburst that throws sparks, a pill with a curled tail) cycle by
 * hero counter.
 *
 * Changes from the sample, and why:
 * - The bubble shape and palette cycle by hero count. The bubble's side, tilt and offset get a seeded jitter from the
 *   cue's index and text, and plain words wrap evenly into rows that fit the safe area.
 * - Every spoken word shows. The sample's plain line dropped the key word (it only lives in the bubble) and honoured one hero; here
 *   the first run of hero words fills the bubble (one word a line) and any later hero word stays in the line as a plain word. A bubble
 *   is sized from its label (the sample's 196 x 106 ellipse, 224 x 188 burst and 388 x 134 pill are the minimum), the label shrinks
 *   before it passes the safe area, and the bubble sits above the line with its tail where the sample's did, clamped inside the safe
 *   area (below the line is never needed: the block fits or the whole block shrinks).
 * - Real speech. The bubble draws on from at most 190 ms before its word but never earlier than the cue's own lead (95 ms before its
 *   first word); the two wipes and the typing compress into the word's own time, so a 100 ms word is whole and its letters all typed
 *   by its last painted frame. The label's letters are `w<word>l<part>` faces, typed 38 ms apart (20 ms before the word), or squeezed
 *   to fit. A cue that meets the cue before gives up lead (never past its spoken start) before the outgoing words give up their 150
 *   ms; the exit (a 150 ms fade and 8 % shrink) waits for the last word's spoken end plus 150 ms and is dropped when it cannot show
 *   two painted frames. Overlapping speakers stack in free space.
 * - Every language. Per-letter typing only for simple scripts and 14 letters or fewer; anything else (Arabic, Devanagari, CJK, a
 *   long word) pops the word in whole. RTL cues mirror the bubble side, tilt and tail.
 * - Budget. The glow is one blurred stroke per bubble (two while it draws on), smaller than the sample's, the soft shadow of the
 *   plain words is one blurred layer, and the idle float only runs on holds of 1.5 s or more.
 *
 * Extra recurring beats in the tube's own language:
 *   sparks    short dashes thrown out of every bubble as it closes;
 *   rings     two small hollow neon rings pop beside the bubble and drift up;
 *   twinkle   a four-point sparkle on the bubble's edge.
 *
 * Real-cue fixes (gallery review, 2026-11-25): the bubble is lifted by its tilted box's own half height (the sample's gap was
 * measured from the unturned box, so a 7 degree burst reached into the line below), and the twinkle takes the first spot on the
 * outline that no label letter reaches (a pill's label fills the old spot) and is left out when there is none.
 */
export const BUBBLE_DEMO: DemoScript = {
  lines: [
    "wait:h@450 you:m did:b what:b",
    "i:m just:m tested:b it:m for:m a:m week:b",
    "no_way:h@620 it:m works:b",
    "and:m it:m costs:b nothing:b",
    "yes:h@420 lets:b go:b",
  ],
  options: { rate: 225, gap: 30, cueGap: 240, tail: 600, lead: 300 },
};

const FACE = "Rubik ExtraBold" as const;
const HERO_FACE = "Rubik Black" as const;
const ANCHOR = 1300;
const HERO_DROP = 120;
const FS = 100;
const ROW_H = 120;
const WORD_GAP = 26;
const BASELINE = 94;
const TRACKING = -0.01;
const LABEL_TRACKING = 0.01;
const LABEL_LINE = 0.98;
const LEAD = 95;
const WORD_LEAD = 60;
const WORD_MS = 220;
const BUBBLE_LEAD = 190;
const DRAW_MS = 210;
const HALF_MS = 130;
const HALF_AT = 80;
const POP_MS = 220;
const TYPE_STEP = 38;
const TYPE_LEAD = 20;
const MAX_TYPED = 14;
const HOLD = 150;
const EXIT_MS = 150;
const EXIT_ANCHOR = 200;
const TUBE = 14;
const CORE = 5;
const GLOW = 24;
const GLOW_BLUR = 9;
const PAD = 40;
const DECO = 64;
/** The tilted bubble's whole bounding box rests this far (sample px) above the line's top, less the kind's gap. */
const TILT_CLEAR = 24;
const IDLE_MIN = 1500;
const FILL = "#0E051C";
const FILL_ALPHA = 0.82;
const SIMPLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;

type Kind = "ellipse" | "burst" | "pill";
const KINDS: readonly Kind[] = ["ellipse", "burst", "pill"];
const KIND_X: Record<Kind, number> = { ellipse: -140, burst: 150, pill: -130 };
const KIND_TILT: Record<Kind, number> = { ellipse: -6, burst: 7, pill: -7 };
const KIND_GAP: Record<Kind, number> = { ellipse: 38, burst: 14, pill: 48 };
const KIND_SPARKS: Record<Kind, number> = { ellipse: 6, burst: 9, pill: 5 };

interface Palette {
  readonly tube: string;
  readonly core: string;
}
const SAMPLE_PINK = "#FF3AA0";
const SAMPLE_FIRE = "#FF8A1E";
const COOL: Palette = { tube: "#3D7BFF", core: "#4DF3FF" };
const lighter = (colour: string, core: string, sample: string): string => (colour.toUpperCase() === sample ? core : mixColour(colour, "#FFFFFF", 0.6));

const seeded = (text: string, salt: number) => {
  let h = 2166136261 ^ salt;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
};

type Space = ReturnType<typeof sceneSpace>;
type Pt = readonly [number, number];

const union = (boxes: readonly Box[]): Box => ({
  x1: Math.min(...boxes.map((b) => b.x1)),
  y1: Math.min(...boxes.map((b) => b.y1)),
  x2: Math.max(...boxes.map((b) => b.x2)),
  y2: Math.max(...boxes.map((b) => b.y2)),
});

const sampled = (fn: (t: number) => number, from: number, to: number, edges: readonly number[], tolerance = 0.25): Frames =>
  to - from < 1 ? [[from, fn(from)]] : sampleFrames(fn, edges, tolerance, { range: [from, to] });

interface Design {
  /** The outline around the body centre (0, 0), canvas px, at rest. */
  readonly pts: readonly Pt[];
  /** Half extents of the body (not the tail), for the sparks. */
  readonly rx: number;
  readonly ry: number;
  readonly bbox: Box;
}

function design(kind: Kind, S: number, w: number, h: number, rtl: boolean): Design {
  const pts: Pt[] = [];
  let rx: number;
  let ry: number;
  if (kind === "ellipse") {
    const rx0 = 196 * S;
    const ry0 = 106 * S;
    const need = (w / 2 / rx0) ** 2 + (h / 2 / ry0) ** 2;
    const k = Math.sqrt(Math.max(1, need / 0.62));
    rx = rx0 * k;
    ry = ry0 * k;
    for (let a = 0; a < 360; a += 4) {
      if (a >= 100 && a <= 132) {
        if (a === 116) pts.push([-118 * S * k, 160 * S * k]);
        continue;
      }
      const r = 1 + 0.03 * Math.sin((a * Math.PI) / 60 + 1) + 0.02 * Math.sin((a * Math.PI) / 36);
      pts.push([rx * r * Math.cos((a * Math.PI) / 180), ry * r * Math.sin((a * Math.PI) / 180)]);
    }
  } else if (kind === "burst") {
    const rx0 = 224 * 0.72 * S;
    const ry0 = 188 * 0.72 * S;
    const need = (w / 2 / rx0) ** 2 + (h / 2 / ry0) ** 2;
    const k = Math.sqrt(Math.max(1, need / 0.85));
    rx = 224 * S * k;
    ry = 188 * S * k;
    const n = 15;
    for (let i = 0; i < n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 === 0 ? 0.94 + 0.09 * Math.sin(i * 2.3) : 0.72;
      pts.push([rx * rr * Math.cos(a), ry * rr * Math.sin(a)]);
    }
  } else {
    const halfH = Math.max(67 * S, (h * 1.15) / 2);
    const halfW = Math.max(194 * S, w / 2 + halfH * 0.55 + 24 * S);
    rx = halfW;
    ry = halfH;
    const r = halfH;
    const lc = -halfW + r;
    const rc = halfW - r;
    const t = halfH / 67;
    pts.push([lc, -halfH], [rc, -halfH]);
    for (let a = -90; a <= 90; a += 6) pts.push([rc + r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180)]);
    pts.push([lc + 150 * t, halfH], [lc + 70 * t, halfH], [lc + 20 * t, halfH + 66 * t], [lc + 6 * t, halfH + 44 * t], [lc - 4 * t, halfH]);
    for (let a = 90; a <= 270; a += 6) pts.push([lc + r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180)]);
  }
  const made = rtl ? pts.map(([x, y]): Pt => [-x, y]) : pts;
  const xs = made.map((p) => p[0]);
  const ys = made.map((p) => p[1]);
  return { pts: made, rx, ry, bbox: { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) } };
}

interface Cell {
  readonly at: number;
  readonly text: string;
  readonly spacing: number;
  /** Centre x, canvas px, at the visual position. */
  readonly cx: number;
  readonly w: number;
  readonly baseline: number;
}

interface LabelLine {
  readonly text: string;
  /** The word the line belongs to and its part number (the first part of a word paints first). */
  readonly word: number;
  readonly part: number;
  readonly letters: readonly { readonly ch: string; readonly x: number }[] | null;
  /** Local centre of the line's box and its baseline, relative to the bubble pivot. */
  readonly cx: number;
  readonly baseline: number;
  readonly inkCentre: number;
}

interface BubbleGeo {
  readonly kind: Kind;
  readonly pal: number;
  readonly design: Design;
  /** The pivot (bbox centre), canvas px, at dy = 0. */
  readonly px: number;
  readonly py: number;
  readonly tilt: number;
  readonly lines: readonly LabelLine[];
  readonly labelSize: number;
  /** Body centre relative to the pivot. */
  readonly body: Pt;
  readonly heroWords: readonly number[];
  readonly typed: boolean;
}

interface Geo {
  readonly rtl: boolean;
  readonly S: number;
  readonly cells: readonly Cell[];
  readonly bubble: BubbleGeo | null;
  readonly box: Box;
}

interface Plan {
  readonly dy: number;
  readonly from: number;
  end: number;
  readonly first: number;
  readonly last: number;
  readonly box: Box;
}

interface Ctx {
  readonly input: SceneInput;
  readonly u: number;
  readonly fps: number;
  readonly frameMs: number;
  readonly space: Space;
}

function layoutCue(cue: SceneCue, input: SceneInput, space: Space, heroCount: number): Geo | null {
  if (cue.words.length === 0) return null;
  const { u, safe } = space;
  const rtl = cueDirection(cue) === "rtl";
  const first = cue.words.findIndex((word) => word.role === "hero");
  let last = first;
  while (first >= 0 && cue.words[last + 1]?.role === "hero") last++;
  const heroWords = first >= 0 ? Array.from({ length: last - first + 1 }, (_, k) => first + k) : [];
  const plainIdx = cue.words.map((_, at) => at).filter((at) => !heroWords.includes(at));
  const kind = KINDS[heroCount % KINDS.length]!;
  const key = cue.words.map((word) => word.text).join(" ");
  const cx = space.x(540);
  const safeW = safe.x2 - safe.x1;
  const safeH = safe.y2 - safe.y1;

  const at = (f: number): Geo | { wide: boolean } => {
    const S = u * f;
    const size = FS * S;
    const gap = WORD_GAP * S;
    const rowH = ROW_H * S;
    const plainTexts = plainIdx.map((i) => cue.words[i]!.text);
    const spacings = plainTexts.map((text) => (SIMPLE.test(text) && !PICTO.test(text) ? TRACKING : 0));
    const widths = plainTexts.map((text, k) => Math.max(1, input.measure(text, FACE, size, spacings[k]!).advance + spacings[k]! * size));
    const maxW = safeW - 2 * DECO * S;
    const rows = widths.length > 0 ? balancedRows(widths, gap, maxW) : [];
    const widest = rows.length > 0 ? Math.max(...rows.map((row) => row.reduce((sum, k) => sum + widths[k]!, 0) + gap * (row.length - 1))) : 0;
    if (widest > maxW + 0.5) return { wide: true };
    const hasHero = heroWords.length > 0;
    const centre = space.y(hasHero ? ANCHOR + HERO_DROP : ANCHOR);
    const rowsTop = centre - (rows.length * rowH) / 2;
    const cells: Cell[] = [];
    rows.forEach((row, r) => {
      const width = row.reduce((sum, k) => sum + widths[k]!, 0) + gap * (row.length - 1);
      const left = cx - width / 2;
      const order = rowVisualOrder(row.map((k) => plainTexts[k]!), rtl ? "rtl" : "ltr").map((k) => row[k]!);
      let x = left;
      for (const k of order) {
        const w = widths[k]!;
        cells.push({ at: plainIdx[k]!, text: plainTexts[k]!, spacing: spacings[k]!, cx: x + w / 2, w, baseline: rowsTop + r * rowH + BASELINE * S });
        x += w + gap;
      }
    });
    const rowsBottom = rowsTop + rows.length * rowH;
    const boxes: Box[] = [];
    if (rows.length > 0) {
      boxes.push({ x1: Math.min(...cells.map((c) => c.cx - c.w / 2)), x2: Math.max(...cells.map((c) => c.cx + c.w / 2)), y1: rowsTop + 10 * S, y2: rowsBottom - 4 * S });
    }

    let bubble: BubbleGeo | null = null;
    if (hasHero) {
      const label = layoutBubble(cue, input, kind, S, safeW, safeH, heroWords, rtl, key, heroCount);
      const { design: d } = label;
      const bw = d.bbox.x2 - d.bbox.x1;
      const bh = d.bbox.y2 - d.bbox.y1;
      const tiltRad = (Math.abs(label.tilt) * Math.PI) / 180;
      const hw = (bw / 2) * Math.cos(tiltRad) + (bh / 2) * Math.sin(tiltRad);
      const hh = (bh / 2) * Math.cos(tiltRad) + (bw / 2) * Math.sin(tiltRad);
      const padX = PAD * S + 0.14 * d.rx;
      const dir = rtl ? -1 : 1;
      const jitter = (seeded(key, 7) - 0.5) * 40 * S;
      const room = safeW / 2 - hw - padX;
      if (room < 0) return { wide: true };
      const px = cx + clamp(dir * KIND_X[kind] * S + jitter, -room, room);
      const bcx = (d.bbox.x1 + d.bbox.x2) / 2;
      const bcy = (d.bbox.y1 + d.bbox.y2) / 2;
      const py = rows.length > 0 ? rowsTop - (KIND_GAP[kind] - TILT_CLEAR) * S - hh : centre;
      void bcx;
      bubble = { ...label, px, py, body: [-bcx, -bcy] };
      boxes.push({ x1: px - hw - padX, x2: px + hw + padX, y1: py - hh - Math.max(PAD * S, 80 * S), y2: py + hh + (rows.length > 0 ? 0 : PAD * S) });
    }
    const box = union(boxes);
    if (box.y2 - box.y1 + 74 * S > safeH || box.x2 - box.x1 + 8 * S > safeW) return { wide: false };
    return { rtl, S, cells, bubble, box };
  };

  let f = 1;
  for (let step = 0; step < 80; step++) {
    const made = at(f);
    if ("box" in made) return made;
    f *= made.wide ? 0.95 : 0.94;
  }
  const last0 = at(f);
  if ("box" in last0) return last0;
  throw new Error("bubble: the cue cannot be fitted");
}

/** The label of the hero run, its bubble shape sized to it and fitted, at block scale S = u * f. */
function layoutBubble(cue: SceneCue, input: SceneInput, kind: Kind, S: number, safeW: number, safeH: number, heroWords: readonly number[], rtl: boolean, key: string, heroCount: number): Omit<BubbleGeo, "px" | "py" | "body"> {
  const upper = (word: number) => toCaptionUpperCase(cue.words[word]!.text, cue.language);
  const subs = heroWords.flatMap((word) =>
    upper(word)
      .split(/\s+/)
      .filter((text) => text.length > 0)
      .map((text) => ({ text, word })),
  );
  const simple = subs.every((sub) => SIMPLE.test(sub.text) && !PICTO.test(sub.text));
  const lettersOf = (word: number) => subs.filter((sub) => sub.word === word).reduce((sum, sub) => sum + [...sub.text].length, 0);
  const typed = simple && heroWords.every((word) => lettersOf(word) <= MAX_TYPED);
  const base = (kind === "pill" ? 118 : subs.length > 1 ? 86 : 100) * S;
  const maxBW = safeW - 2 * (PAD * S);
  const maxBH = safeH * 0.45;
  let g = 1;
  let out: ReturnType<typeof attempt> | null = null;
  function attempt(gg: number) {
    const size = base * gg;
    const lineH = LABEL_LINE * size;
    const spacing = LABEL_TRACKING * size;
    const measure = (text: string) => input.measure(text, HERO_FACE, size, LABEL_TRACKING);
    // Measure the same runs that will paint, including the ink above and below each baseline.
    const measureLine = (text: string) => {
      const runs = (typed ? [...text] : [text]).map((ch) => ({ ch, ...measure(ch) }));
      const width = runs.reduce((sum, run) => sum + run.advance, spacing * (runs.length - 1));
      const inkTop = Math.min(...runs.map((run) => run.inkTop));
      const inkBottom = Math.max(...runs.map((run) => run.inkBottom));
      return { text, letters: typed ? runs : null, width, inkTop, inkBottom };
    };
    // One sub-word a line, up to three lines; more words wrap evenly (the sample splits only on spaces).
    let rows: number[][] = subs.map((_, k) => [k]);
    if (subs.length > 3) rows = balancedRows(subs.map((sub) => measureLine(sub.text).width), 0.3 * size, 470 * S * gg);
    const lines = rows.map((row) => ({ ...measureLine(row.map((k) => subs[k]!.text).join(" ")), first: row[0]! }));
    const w = Math.max(...lines.map((line) => line.width));
    const inkTop = Math.min(...lines.map((line, i) => i * lineH + line.inkTop));
    const inkBottom = Math.max(...lines.map((line, i) => i * lineH + line.inkBottom));
    const h = Math.max(lines.length * lineH, inkBottom - inkTop);
    const d = design(kind, S, w, h, rtl);
    return { size, lineH, lines, inkCentre: (inkTop + inkBottom) / 2, d };
  }
  for (let step = 0; step < 90; step++) {
    out = attempt(g);
    const bw = out.d.bbox.x2 - out.d.bbox.x1;
    const bh = out.d.bbox.y2 - out.d.bbox.y1;
    if (bw <= maxBW && bh <= maxBH) break;
    g *= 0.94;
  }
  const { size, lineH, lines, inkCentre, d } = out!;
  const bcx = (d.bbox.x1 + d.bbox.x2) / 2;
  const bcy = (d.bbox.y1 + d.bbox.y2) / 2;
  const centreX = -bcx;
  const firstBaseline = -bcy - inkCentre;
  const labelLines: LabelLine[] = [];
  const partOf = new Map<number, number>();
  lines.forEach((line, i) => {
    const sub = subs[line.first]!;
    const part = partOf.get(sub.word) ?? 0;
    partOf.set(sub.word, part + 1);
    const baseline = firstBaseline + i * lineH;
    let x = centreX - line.width / 2;
    const letters = line.letters?.map(({ ch, advance }) => {
      const placed = { ch, x };
      x += advance + LABEL_TRACKING * size;
      return placed;
    }) ?? null;
    labelLines.push({
      text: line.text, word: sub.word, part, letters, cx: centreX, baseline,
      inkCentre: baseline + (line.inkTop + line.inkBottom) / 2,
    });
  });
  const jitter = (seeded(key, 11) - 0.5) * 3;
  const tilt = (rtl ? -1 : 1) * KIND_TILT[kind] + jitter;
  return { kind, pal: heroCount % KINDS.length, design: d, tilt, lines: labelLines, labelSize: size, heroWords, typed };
}

/** The exit of one cue: a fade and a small shrink, after the last word has been spoken and read. */
interface Exit {
  readonly from: number;
  readonly dur: number;
  readonly to: number;
}

function exitOf(plan: Plan, frameMs: number): Exit | null {
  const room = plan.end - (plan.last + HOLD);
  if (room < frameMs * 2.2) return null;
  const dur = Math.min(EXIT_MS, room);
  const from = clamp(plan.end - EXIT_ANCHOR, plan.last + HOLD, Math.max(plan.last + HOLD, plan.end - dur));
  return { from, dur, to: Math.min(plan.end, Math.ceil(from + dur)) };
}

const fade = (ex: Exit | null, frames: Frames): Frames => (ex ? [...frames, [ex.from, frames.at(-1)![1]], [ex.to, 0, "out"]] : frames);

function buildCue(n: number, cue: SceneCue, geo: Geo, plan: Plan, pal: readonly Palette[], ctx: Ctx): Piece[] {
  const { input, frameMs, space } = ctx;
  const { S, cells, bubble } = geo;
  const { dy, from, end } = plan;
  if (end <= from) return [];
  const z = n * 10;
  const pieces: Piece[] = [];
  const ex = exitOf(plan, frameMs);
  const goneAt = ex ? ex.to : end;
  const size = FS * S;

  // The plain line: each word rises, sharpens and fades in 60 ms before it is spoken.
  for (const cell of cells) {
    const word = cue.words[cell.at]!;
    const lead = cell.at === 0 || word.startMs <= plan.first ? word.startMs - from : WORD_LEAD;
    const a = Math.max(from, word.startMs - Math.min(WORD_LEAD, Math.max(0, lead)));
    const o0 = word.startMs - a < 40 ? 0.7 : 0;
    const pivot = cell.baseline - 0.35 * size + dy;
    const exitScale: Frames | null = ex ? [[ex.from, 1], [ex.to, 0.92, "out"]] : null;
    const track: Track = {
      x: [[a, cell.cx]],
      y: [[a, pivot + 20 * S], [a + WORD_MS, pivot, "outExpo"]],
      o: fade(ex, [[a, o0], [a + (o0 > 0 ? 30 : 37), 1]]),
      blur: [[a, 7 * S], [a + WORD_MS, 0, "out"]],
      ...(exitScale ? { sx: exitScale, sy: exitScale } : {}),
    };
    pieces.push({
      id: `bubble:${n}:w${cell.at}`, kind: "text", z: z + 3, fromMs: a, toMs: goneAt, track,
      text: cell.text, face: FACE, sizePx: size, letterSpacingEm: cell.spacing, fill: input.colours.primary, anchor: "baseline-center",
      origin: { dx: 0, dy: -0.35 * size }, language: cue.language,
      shadows: [
        { dx: 0, dy: 5 * S, blur: 0, colour: input.colours.shadow, alpha: 0.5 },
        ...(cue.words.length > 12 ? [] : [{ dx: 0, dy: 10 * S, blur: 9 * S, colour: input.colours.shadow, alpha: 0.6 }]),
      ],
    } satisfies TextPiece);
  }

  if (bubble) pieces.push(...bubblePieces(n, cue, geo, bubble, plan, ex, pal, ctx));

  const margin = 2 * ctx.u;
  const safe = { x1: space.safe.x1 + margin, y1: space.safe.y1 + margin, x2: space.safe.x2 - margin, y2: space.safe.y2 - margin };
  const withinCue = pieces.map((piece) => piece.fromMs < from ? { ...piece, fromMs: from } : piece);
  return clampToSafeArea(withinCue, safe, input.measure).filter((piece) => /^bubble:\d+:w\d+(?:l\d+)?$/.test(piece.id) || hasTwoPaintedFrames(piece, input));
}

interface Spark {
  readonly cx: number;
  readonly cy: number;
  readonly angle: number;
  readonly r0: number;
  readonly r1: number;
  readonly yScale: number;
  readonly tube: boolean;
}

/** The dashes thrown out of a body centre: from r0 to r1, fading, shrinking along their length. */
function sparkPieces(n: number, id: string, sparks: readonly Spark[], at: number, window: number, stop: number, palette: Palette, S: number, fps: number, z: number): Piece[] {
  const to = Math.min(stop, at + window);
  if (paintedFrameCount(at, to, fps) < 3) return [];
  return sparks.map((spark, k): ShapePiece => {
    const dx = Math.cos(spark.angle);
    const dyv = Math.sin(spark.angle) * spark.yScale;
    const len = 28 * S;
    const thick = 8 * S;
    return {
      id: `bubble:${n}:${id}${k}`, kind: "shape", z, fromMs: at, toMs: to,
      track: {
        x: [[at, spark.cx + dx * spark.r0], [at + window, spark.cx + dx * spark.r1, "outExpo"]],
        y: [[at, spark.cy + dyv * spark.r0], [at + window, spark.cy + dyv * spark.r1, "outExpo"]],
        rz: [[at, (spark.angle * 180) / Math.PI]],
        sx: [[at, 1.2], [at + window, 0.4]],
        o: [[at, 1], [at + window, 0, "in"]],
      },
      path: roundedRectPath(0, 0, len, thick, thick / 2), origin: { dx: len / 2, dy: thick / 2 },
      fill: { colour: spark.tube ? palette.tube : palette.core },
    };
  });
}

/** A small hollow ring that pops, drifts up and fades. */
function ringPiece(n: number, k: number, x: number, y: number, r: number, at: number, to: number, drift: Pt, palette: Palette, S: number, z: number): ShapePiece {
  const life = to - at;
  const pop = Math.min(160, life * 0.35);
  return {
    id: `bubble:${n}:ring${k}`, kind: "shape", z, fromMs: at, toMs: to,
    track: {
      x: [[at, x], [to, x + drift[0], "out"]],
      y: [[at, y], [to, y + drift[1], "out"]],
      sx: [[at, 0.3], [at + pop, 1, "outBack"]],
      sy: [[at, 0.3], [at + pop, 1, "outBack"]],
      o: [[at, 1], [at + life * 0.55, 1], [to, 0, "in"]],
    },
    path: ellipsePath(r, r, r), origin: { dx: r, dy: r },
    stroke: { widthPx: 4 * S, colour: palette.tube },
  };
}

function bubblePieces(n: number, cue: SceneCue, geo: Geo, bubble: BubbleGeo, plan: Plan, ex: Exit | null, pals: readonly Palette[], ctx: Ctx): Piece[] {
  const { input, fps, frameMs } = ctx;
  const { S, rtl } = geo;
  const { dy, from, end } = plan;
  const palette = pals[bubble.pal]!;
  const z = n * 10;
  const out: Piece[] = [];
  const hero0 = cue.words[bubble.heroWords[0]!]!;
  const s = hero0.startMs;
  const e = hero0.endMs;
  const goneAt = ex ? ex.to : end;
  const bs = Math.max(from, s - BUBBLE_LEAD);
  const px = bubble.px;
  const py = bubble.py + dy;
  const { design: d, tilt } = bubble;
  const bw = d.bbox.x2 - d.bbox.x1;
  const bh = d.bbox.y2 - d.bbox.y1;
  const drawMs = Math.min(DRAW_MS, e - bs - 2 * frameMs);
  const drawOn = drawMs >= 2.5 * frameMs;
  const doneAt = bs + (drawOn ? drawMs : 0);
  const k = drawOn ? drawMs / DRAW_MS : 1;
  const half = HALF_MS * k;
  const halfAt = HALF_AT * k;
  const idle = goneAt - doneAt >= IDLE_MIN;
  const hold = (t: number) => Math.max(0, t - doneAt);
  const exitP = (t: number) => (ex ? EASES.out(prog(t, ex.from, ex.dur)) : 0);
  const sFn = (t: number) => lerp(0.9, 1, EASES.outExpo(prog(t, bs, POP_MS))) * (1 - 0.08 * exitP(t));
  const rFn = (t: number) => tilt + (idle ? Math.sin(hold(t) / 760) * 0.8 : 0);
  const yFn = (t: number) => py + (idle ? Math.sin(hold(t) / 520) * 2.5 * S : 0);
  const edges = [bs, bs + POP_MS, doneAt, ex?.from ?? goneAt, goneAt];
  const group: Track = {
    x: [[bs, px]],
    y: idle ? sampled(yFn, bs, goneAt, edges, 0.2) : [[bs, py]],
    sx: sampled(sFn, bs, goneAt, edges, 0.002),
    rz: idle ? sampled(rFn, bs, goneAt, edges, 0.06) : [[bs, tilt]],
  };
  group.sy = group.sx;
  const o = (): Frames | undefined => (ex ? fade(ex, [[bs, 1]]) : undefined);
  const withO = (extra: Track = {}): Track => ({ ...group, ...(o() ? { o: o()! } : {}), ...extra });
  const path = polygonPath(d.pts.map(([x, y]): Pt => [x - (d.bbox.x1 + d.bbox.x2) / 2, y - (d.bbox.y1 + d.bbox.y2) / 2]));
  const origin = { dx: 0, dy: 0 };
  const pad = PAD * S;
  const sinT = Math.abs(Math.sin((tilt * Math.PI) / 180));
  const l1 = -bw / 2 - pad;
  const l2 = bw / 2 + pad;
  const top = -bh / 2 - pad - sinT * (bw / 2);
  const bottom = bh / 2 + pad + sinT * (bw / 2);
  const mid = bubble.body[1];
  const glow = (id: string, track: Track, clip?: Clip, fromMs = bs, toMs = goneAt): ShapePiece => ({
    id: `bubble:${n}:${id}`, kind: "shape", z: z + 2, fromMs, toMs, track: { ...track, blur: [[fromMs, GLOW_BLUR * S]] },
    ...(clip ? { clip } : {}), path, origin, stroke: { widthPx: GLOW * S, colour: palette.tube },
  });
  const tube = (id: string, track: Track, clip?: Clip, fromMs = bs, toMs = goneAt): ShapePiece => ({
    id: `bubble:${n}:${id}`, kind: "shape", z: z + 3, fromMs, toMs, track,
    ...(clip ? { clip } : {}), path, origin, fill: { colour: FILL, alpha: FILL_ALPHA }, stroke: { widthPx: TUBE * S, colour: palette.tube },
  });
  const core = (id: string, track: Track, clip?: Clip, fromMs = bs, toMs = goneAt): ShapePiece => ({
    id: `bubble:${n}:${id}`, kind: "shape", z: z + 4, fromMs, toMs, track,
    ...(clip ? { clip } : {}), path, origin, stroke: { widthPx: CORE * S, colour: palette.core },
  });

  if (drawOn) {
    // Two wipes: the top half sweeps across, then the bottom half sweeps back.
    const p1 = (t: number) => EASES.inOut(prog(t, bs, half));
    const p2 = (t: number) => EASES.inOut(prog(t, bs + halfAt, half));
    const wEdges = [bs, bs + half, bs + halfAt, bs + halfAt + half, bs + POP_MS, doneAt];
    const fr = (fn: (t: number) => number) => sampled(fn, bs, doneAt, wEdges, 0.4);
    const topClip: Clip = {
      x1: fr((t) => px + sFn(t) * l1), x2: fr((t) => px + sFn(t) * (l1 + p1(t) * (l2 - l1))),
      y1: fr((t) => py + sFn(t) * top), y2: fr((t) => py + sFn(t) * mid),
    };
    const bottomClip: Clip = {
      x1: fr((t) => px + sFn(t) * (l2 - p2(t) * (l2 - l1))), x2: fr((t) => px + sFn(t) * l2),
      y1: fr((t) => py + sFn(t) * mid), y2: fr((t) => py + sFn(t) * bottom),
    };
    for (const [name, clip] of [["t", topClip], ["b", bottomClip]] as const) {
      out.push(glow(`gl${name}`, { ...group }, clip, bs, doneAt), tube(`tb${name}`, { ...group }, clip, bs, doneAt), core(`co${name}`, { ...group }, clip, bs, doneAt));
    }
  }
  // One flicker of the glow as the outline closes.
  const flicker: Frames = [[doneAt, 1], [doneAt + 40, 0.4], [doneAt + 90, 1], [doneAt + 150, 0.55], [doneAt + 210, 1]];
  const flickerAt = (t: number) => (t < doneAt ? 1 : Math.min(...[1]) * (t >= doneAt + 210 ? 1 : flickerValue(t, flicker))) * (1 - exitP(t));
  const glowO = sampled(flickerAt, doneAt, goneAt, [doneAt, doneAt + 40, doneAt + 90, doneAt + 150, doneAt + 210, ex?.from ?? goneAt, goneAt], 0.03);
  out.push(glow("gl", { ...withO(), o: glowO }, undefined, doneAt), tube("tb", withO(), undefined, doneAt), core("co", withO(), undefined, doneAt));

  // The label: typed letter by letter (20 ms before the word, 38 ms apart, squeezed into the word's own time), or popped whole.
  const size = bubble.labelSize;
  const glowShadow = { dx: 0, dy: 0, blur: 7 * S, colour: palette.tube, alpha: 0.85 };
  const hardShadow = { dx: 0, dy: 4 * S, blur: 0, colour: input.colours.shadow, alpha: 0.45 };
  const shadows = bubble.lines.length * (bubble.lines[0]?.letters?.length ?? 1) > 18 ? [hardShadow] : [glowShadow, hardShadow];
  const typeFrom = new Map<number, number>();
  for (const line of bubble.lines) {
    const word = cue.words[line.word]!;
    if (bubble.typed && line.letters) {
      const count = [...bubble.lines.filter((l) => l.word === line.word).flatMap((l) => (l.letters ? l.letters.map(() => 0) : []))].length;
      const t0 = Math.max(from, word.startMs - TYPE_LEAD);
      const latest = word.endMs - 2 * frameMs - 2;
      const step = count > 1 ? clamp((latest - t0) / (count - 1), 0, TYPE_STEP) : 0;
      let done = typeFrom.get(line.word) ?? 0;
      line.letters.forEach((letter, i) => {
        const at = t0 + (done + i) * step;
        if (paintedFrameCount(at, goneAt, fps) < 2) return;
        out.push({
          id: `bubble:${n}:w${line.word}l${line.part * 100 + i}`, kind: "text", z: z + 6, fromMs: at, toMs: goneAt, track: withO(),
          text: letter.ch, face: HERO_FACE, sizePx: size, letterSpacingEm: LABEL_TRACKING, fill: input.colours.primary, anchor: "baseline-left",
          origin: { dx: -letter.x, dy: -line.baseline }, language: cue.language, shadows,
        } satisfies TextPiece);
      });
      done += line.letters.length;
      typeFrom.set(line.word, done);
    } else {
      // Popped whole: the label springs from 60 % to full size about its own centre, 30 ms before the word.
      const at = Math.max(from, word.startMs - 30);
      if (paintedFrameCount(at, goneAt, fps) < 2) continue;
      const c = Math.cos((tilt * Math.PI) / 180);
      const sn = Math.sin((tilt * Math.PI) / 180);
      const lx = line.cx;
      const ly = line.inkCentre;
      const popTo = at + Math.min(240, Math.max(frameMs * 2, e - at - frameMs));
      const spring: Frames = [[at, 0.6], [popTo, 1, "spring"]];
      const sxFrames = ex ? ([...spring, [ex.from, 1], [ex.to, 0.92, "out"]] as Frames) : spring;
      out.push({
        id: `bubble:${n}:w${line.word}l${line.part}`, kind: "text", z: z + 6, fromMs: at, toMs: goneAt,
        track: { x: [[at, px + lx * c - ly * sn]], y: [[at, py + lx * sn + ly * c]], sx: sxFrames, sy: sxFrames, rz: [[at, tilt]], ...(ex ? { o: fade(ex, [[at, 1]]) } : {}) },
        text: line.text, face: HERO_FACE, sizePx: size, letterSpacingEm: LABEL_TRACKING, fill: input.colours.primary, anchor: "baseline-center",
        origin: { dx: 0, dy: ly - line.baseline }, language: cue.language, shadows,
      } satisfies TextPiece);
    }
  }

  // Body centre, canvas px, at rest.
  const c = Math.cos((tilt * Math.PI) / 180);
  const sn = Math.sin((tilt * Math.PI) / 180);
  const bx = px + bubble.body[0] * c - bubble.body[1] * sn;
  const by = py + bubble.body[0] * sn + bubble.body[1] * c;

  // Sparks.
  const count = KIND_SPARKS[bubble.kind];
  const sparks: Spark[] = [];
  const base = seeded(cue.words.map((word) => word.text).join(" "), 23) * 0.8;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + 0.3 + base;
    if (Math.sin(angle) > 0.75) continue;
    sparks.push({ cx: bx, cy: by, angle, r0: 0.67 * d.rx, r1: 1.12 * d.rx, yScale: (d.ry / d.rx) * 0.98, tube: i % 2 === 1 });
  }
  out.push(...sparkPieces(n, "sp", sparks, doneAt - 20, 330, goneAt, palette, S, fps, z + 7));

  // Rings and a twinkle on the bubble's upper edge, on opposite sides.
  const side = seeded(cue.words.map((word) => word.text).join(" "), 31) < 0.5 ? -1 : 1;
  const ringAt = doneAt + 40;
  for (let i = 0; i < 2; i++) {
    const phi = ((-62 + i * 24 + (seeded(`${cue.index}`, 41 + i) - 0.5) * 12) * Math.PI) / 180;
    const x = bx + side * Math.cos(phi) * d.rx * 1.12;
    const y = by + Math.sin(phi) * d.ry * 1.12;
    const r = (9 + 7 * seeded(`${cue.index}r`, 51 + i)) * S;
    const at = ringAt + i * 110;
    const to = Math.min(goneAt, at + 640);
    if (paintedFrameCount(at, to, fps) >= 3) out.push(ringPiece(n, i, x, y, r, at, to, [side * 6 * S, -34 * S], palette, S, z + 7));
  }
  const tw = doneAt + 60;
  const twTo = Math.min(goneAt, tw + 640);
  if (paintedFrameCount(tw, twTo, fps) >= 4) {
    const sr = (16 + 8 * seeded(`${cue.index}s`, 61)) * S;
    // The sparkle sits on the bubble's upper edge, upper-left by default; a pill's label fills its edge, so the sparkle takes the
    // first spot on the outline (or just outside it) that no letter's box reaches, and is left out when there is none.
    const letters = out.flatMap((piece) => (piece.kind === "text" && /^bubble:\d+:w\d+l\d+$/.test(piece.id) ? [piece] : []));
    const inked = letters.flatMap((piece) => pieceBounds(piece, Math.max(piece.fromMs, tw) + 1, input.measure) ?? []);
    const reach = sr * 1.42 + 2 * S;
    const spots = [-132, -145, -120, -158, -108, -170].flatMap((deg) => [1.08, 1.2].map((f) => ({ deg, f })));
    const spot = spots
      .map(({ deg, f }) => {
        const phi = (deg * Math.PI) / 180;
        return { x: bx - side * Math.cos(phi) * d.rx * f, y: by + Math.sin(phi) * d.ry * f };
      })
      .find(({ x, y }) => !inked.some((b) => x - reach < b.x2 && b.x1 < x + reach && y - reach < b.y2 && b.y1 < y + reach));
    const life = twTo - tw;
    const pulse: Frames = [[tw, 0.2], [tw + life * 0.28, 1, "outBack"], [tw + life * 0.55, 0.6], [tw + life * 0.78, 1], [twTo, 0, "in"]];
    if (spot) {
      out.push({
        id: `bubble:${n}:twinkle`, kind: "shape", z: z + 7, fromMs: tw, toMs: twTo,
        track: { x: [[tw, spot.x]], y: [[tw, spot.y]], sx: pulse, sy: pulse, rz: [[tw, 0], [twTo, 90]] },
        path: sparklePath(sr, sr, sr), origin: { dx: sr, dy: sr }, fill: { colour: palette.core },
      });
    }
  }
  void rtl;
  return out;
}

function flickerValue(t: number, frames: Frames): number {
  for (let i = 1; i < frames.length; i++) {
    const [a, va] = frames[i - 1]!;
    const [b, vb] = frames[i]!;
    if (t <= b) return lerp(va, vb, (t - a) / (b - a || 1));
  }
  return frames.at(-1)![1];
}

export const bubbleProgram: SceneProgram = {
  build(input) {
    const space = sceneSpace(input, ANCHOR);
    const fps = input.fps ?? SCENE_DEFAULT_FPS;
    const pal: Palette[] = [
      { tube: input.colours.highlight, core: lighter(input.colours.highlight, "#B98CFF", SAMPLE_PINK) },
      { tube: input.colours.accent, core: lighter(input.colours.accent, "#FFE04A", SAMPLE_FIRE) },
      COOL,
    ];
    let heroCount = 0;
    const pieces: Piece[] = [];
    for (const window of speechWindows(input, space.safe, LEAD, HOLD)) {
      const { cue, index: n, start, spokenEnd, from, to, bounds } = window;
      const lane = speechLaneSpace(space, bounds, ANCHOR);
      const geo = layoutCue(cue, input, lane, heroCount);
      if (!geo) continue;
      if (geo.bubble) heroCount++;
      const plan: Plan = { dy: 0, from, end: to, first: start, last: spokenEnd, box: geo.box };
      const ctx: Ctx = { input, u: space.u, fps, frameMs: 1000 / sceneSampleRate(fps), space: lane };
      pieces.push(...buildCue(n, cue, geo, plan, pal, ctx));
    }
    return { pieces };
  },
};
