import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, fitScale, greedyRows, rowVisualOrder, sceneSpace } from "../layout";
import { type Clip, type PathCmd, type Piece, type ShapePiece, type TextPiece, mixColour } from "../scene";
import { rectPath } from "../shapes";

/**
 * Premiere (`samples/templates/m04-poster.js`): a film-festival poster set as captions. Tall amber condensed caps (Anton)
 * wipe in word by word, each with a brief glow as it lands; the key word writes on in a cream retro script (Yesteryear,
 * tipped -6 degrees, a dark knockout around it) across the caps stack with a four-point sparkle popping at its end; a
 * hairline and a tiny credit line sit under the block, and the whole poster pushes in 3 % while the cue holds.
 *
 * Geometry is the sample's, read in Chrome (`probe-sample.ts`): caps 200 / 172 / 150 px by the cue's character count
 * (Anton, line box 0.98 em, baseline 0.9135 em, 0.16 em between words, rows wrapped greedily at 860 px), the script at
 * 1.12x with a 0.075 em knockout, its box padded 0.18 / 0.3 / 0.34 em and pulled over the caps by 0.5 / 0.48 / 0.4 em
 * (first / last / middle), the block centred on y 1290 with 26 px, a 3 px rule, 16 px and the credit line below.
 *
 * What changed from the sample, and why (Gallery 2 brief):
 * - The credit line "IN CONVERSATION - EP. 12" was invented text: it is now the cue's own clip time (`00:12`), set the same way.
 * - Caps size came from the cue's character count only; every cue now also fits its widest word to the row (no floor: a
 *   word cannot wrap), the script fits the safe width, and the whole block fits the safe height (16:9).
 * - A lone script word (no caps) had `dx = Infinity` and was pushed to the frame's edge: it is centred, and the rule
 *   clears it.
 * - The script's placement is clamped to the safe area (the sample's 70 to 1010 px) and mirrors for right-to-left cues
 *   (caps wipe, rule and credit run from the right).
 * - Recurring variants (the sample's cues are one fixed look): the script's tilt, the sparkle's corner and size cycle by a
 *   per-hero-cue counter; the rule's width and alignment (centre / leading / trailing) cycle by cue number; a cue without
 *   a script gets a sparkle too, on its last word's top corner, its first word's or its last word's bottom, cycling by
 *   its own counter. The sparkle twinkles while a cue holds. All jitter is a hash of the cue's index and text.
 * - Exit: the sample's 120 ms fade ends 80 ms before the cue's end; it now never starts before the last word has landed
 *   and been readable for 150 ms (it shortens, down to 60 ms, and may run 60 ms into the next cue in fast speech).
 * - Glow: the sample's text-shadow of 18 to 44 px is a blurred copy of the word under it (sigma 0.1 em falling to 0.06 em),
 *   lit and fading as the sample's; the 22 px caps shadow is one small blurred layer; the script's 20 px shadow likewise.
 * - Cased scripts only (Latin, Cyrillic, Greek) are upper-cased; other scripts keep their letters and take no letter spacing.
 * - The script's wipe is a canvas-axis clip across its tilted box (the sample's inset() leans with the 6 degree tilt).
 */

export const PREMIERE_DEMO: DemoScript = {
  lines: [
    "Nobody:b tells:b you:m this",
    "quiet:h@600 years:b matter:b most:b",
    "that's:m where:b it:m all:m gets:b built",
    "so:m keep:b going:h@640",
  ],
  options: { rate: 290, cueGap: 160, tail: 800, lead: 350 },
};

const CENTER_Y = 1290;
const MAX_W = 860;
const PAD = 0.24;
const CAPS_FACE = "Anton" as const;
const SCRIPT_FACE = "Yesteryear" as const;
const MICRO_FACE = "Inter Tight SemiBold" as const;
const CAPS_LS = 0.004;
const KNOCKOUT = "#140E06";
const GLOW_MIX = 0.3;
/** Anton: `line-height: 0.98` box and where Chrome puts the baseline in it. */
const CAPS_LINE = 0.98;
const CAPS_BASELINE = 0.9135;
const CAPS_CAP_HEIGHT = 0.859;
const CAPS_GAP = 0.16;
/** Yesteryear at `line-height: 1` (probe: 0.744 at 168 px, 0.741 at 224 px). */
const SCRIPT_BASELINE = 0.742;
const SCRIPT_SCALE = 1.12;
const SCRIPT_PAD = { top: 0.18, side: 0.3, bottom: 0.34 } as const;
const SCRIPT_BOX = SCRIPT_PAD.top + 1 + SCRIPT_PAD.bottom;
const SCRIPT_KNOCKOUT_EM = 0.075;
const TILTS = [-6, -4, -7, -5] as const;
const PUSH = 0.03;
const EXIT_MS = 120;
const EXIT_MIN_MS = 60;
const OVERLAP_MS = 60;
const EXIT_LIFT = 18;
const EXIT_BLUR = 8;
const READABLE_MS = 150;
const RULE_H = 3;
const RULE_WIDTHS = [200, 150, 260] as const;
const FOOT_ALIGNS = ["center", "lead", "trail"] as const;
const MICRO_SIZE = 22;
const MICRO_LS = 0.34;
const MICRO_BASELINE = 0.973;
const MICRO_LINE = 26.5;
const SPARKLE_SIZES = [23, 20, 26] as const;
const HERO_SPOTS = ["trail-top", "lead-bottom", "lead-top", "trail-bottom"] as const;
const PLAIN_SPOTS = ["last-top", "first-top", "last-bottom"] as const;
const TWINKLE_MS = 1300;
/** The spring's highest scale, so a sparkle's reach is counted at its peak. */
const SPRING_PEAK = Math.max(...Array.from({ length: 201 }, (_, at) => EASES.spring(at / 200)));
const CASED = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u;
const SHADOW = "#000000";
const NON_CASED_SCALE = 0.75;

/** The sample's sparkle (radius 50), centred on (0, 0). */
const SPARKLE_UNIT: readonly PathCmd[] = [
  ["M", 0, -50],
  ["C", 4, -14, 14, -4, 50, 0],
  ["C", 14, 4, 4, 14, 0, 50],
  ["C", -4, 14, -14, 4, -50, 0],
  ["C", -14, -4, -4, -14, 0, -50],
  ["Z"],
];

/** FNV-1a over a cue's index and text: the one source of jitter (never `Math.random`). */
export function premiereHash(index: number, text: string): number {
  let h = (2166136261 ^ index) >>> 0;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return h >>> 0;
}

/** The sample's caps size in sample px from the cue's character count (a letter and a space per caps word). */
export function premiereCapsSize(capsChars: number): number {
  return capsChars <= 10 ? 200 : capsChars <= 16 ? 172 : 150;
}

/** The credit line: the cue's own clip time, `mm:ss`. */
export function premiereTimestamp(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const upper = (text: string) => (CASED.test(text) ? text.toUpperCase() : text);
const length = (text: string) => [...text].length;
const capsDuration = (text: string) => clamp(length(text) * 46, 170, 360);
const scriptDuration = (text: string) => clamp(length(text) * 80, 320, 540);

interface CapsWord {
  readonly index: number;
  readonly text: string;
  /** Text box (advance plus the trailing letter spacing), px. */
  readonly box: number;
  left: number;
}

interface CapsRow {
  readonly words: CapsWord[];
  left: number;
  right: number;
  top: number;
  /** Line box above and below the baseline: Anton's 0.98 em box, or the ink of a script the face lacks. */
  up: number;
  height: number;
}

function buildCue(cue: SceneCue, cueNumber: number, counters: { hero: number; plain: number }, input: SceneInput): Piece[] {
  const space = sceneSpace(input, CENTER_Y);
  const { u, safe } = space;
  const rtl = cueDirection(cue) === "rtl";
  const dir = rtl ? -1 : 1;
  const cx = space.x(540);
  const cy = space.y(CENTER_Y);
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const hero = heroAt >= 0 ? cue.words[heroAt]! : null;
  const lead = cue.words.map((_, at) => at).filter((at) => (hero ? at < heroAt : true));
  const tail = hero ? cue.words.map((_, at) => at).filter((at) => at > heroAt) : [];
  const capsIndices = cue.words.map((_, at) => at).filter((at) => at !== heroAt);
  const seed = premiereHash(cue.index, cue.words.map((word) => word.text).join(" "));
  const heroCounter = hero ? counters.hero++ : 0;
  const plainCounter = hero ? 0 : counters.plain++;
  const maxW = Math.min(MAX_W * u, safe.x2 - safe.x1);

  // --- size: the sample's tier, then the widest word fits a row (a word cannot wrap), the script fits the width, the block fits the height ---
  const capsText = (at: number) => upper(cue.words[at]!.text);
  const capsLs = (at: number) => (CASED.test(cue.words[at]!.text) ? CAPS_LS : 0);
  const capsBox = (at: number, size: number) => input.measure(capsText(at), CAPS_FACE, size, capsLs(at)).advance + capsLs(at) * size;
  const capsChars = capsIndices.reduce((sum, at) => sum + length(cue.words[at]!.text) + 1, 0);
  let size = premiereCapsSize(capsChars) * u;
  // Nastaliq, Devanagari and CJK fallbacks draw far taller ink than Anton at the same size: start those cues smaller.
  if (cue.words.some((word) => !CASED.test(word.text))) size *= NON_CASED_SCALE;
  if (capsIndices.length > 0) size *= fitScale(Math.max(...capsIndices.map((at) => capsBox(at, size))), maxW);

  const tilt = TILTS[heroCounter % TILTS.length]! + ((seed % 5) - 2) * 0.3;
  const tiltRad = (Math.abs(tilt) * Math.PI) / 180;
  const scriptText = hero?.text ?? "";
  const scriptAdvance = (fs: number) => (hero ? input.measure(scriptText, SCRIPT_FACE, fs, 0).advance : 0);
  /** The widest the tipped script reaches sideways: its run turned, plus the knockout band and its shadow (sigma 7 px, three each side). */
  const scriptReach = (fs: number) => scriptAdvance(fs) * Math.cos(tiltRad) + 1.4 * fs * Math.sin(tiltRad) + SCRIPT_KNOCKOUT_EM * fs + 6 * 7 * u;
  let scriptScale = 1;
  if (hero) scriptScale = fitScale(1.03 * scriptReach(SCRIPT_SCALE * size), safe.x2 - safe.x1);

  interface Layout {
    rows: CapsRow[];
    hero: { fs: number; W: number; H: number; top: number; dx: number; reach: number } | null;
    height: number;
    blockTop: number;
    foot: { ruleTop: number; microTop: number; left: number; right: number };
  }
  const layout = (sz: number): Layout => {
    const gap = CAPS_GAP * sz;
    const place = (group: readonly number[]): CapsRow[] => {
      const boxes = group.map((at) => capsBox(at, sz));
      return greedyRows(boxes, gap, maxW).map((row) => {
        const order = rowVisualOrder(row.map((at) => cue.words[group[at]!]!.text), rtl ? "rtl" : "ltr").map((at) => row[at]!);
        const width = order.reduce((sum, at) => sum + boxes[at]!, 0) + gap * (order.length - 1);
        let x = cx - width / 2;
        const words = order.map((at): CapsWord => {
          const word = { index: group[at]!, text: capsText(group[at]!), box: boxes[at]!, left: x };
          x += boxes[at]! + gap;
          return word;
        });
        // A row with text Anton cannot draw (Arabic, Devanagari, CJK ...) is as tall as its ink, so rows never overlap.
        let up = CAPS_BASELINE * sz;
        let down = (CAPS_LINE - CAPS_BASELINE) * sz;
        if (words.some((word) => !CASED.test(word.text))) {
          for (const word of words) {
            const m = input.measure(word.text, CAPS_FACE, sz, 0);
            up = Math.max(up, -m.inkTop);
            down = Math.max(down, m.inkBottom);
          }
        }
        return { words, left: cx - width / 2, right: cx + width / 2, top: 0, up, height: up + down };
      });
    };
    const leadRows = place(lead);
    const tailRows = place(tail);
    const fs = SCRIPT_SCALE * sz * scriptScale;
    const W = scriptAdvance(fs) + 2 * SCRIPT_PAD.side * fs;
    const H = SCRIPT_BOX * fs;
    // The script's margins by where it sits in the stack (the sample's `place`); alone it keeps clear of the rule.
    const solo = leadRows.length === 0 && tailRows.length === 0;
    const spot = leadRows.length === 0 ? "first" : tailRows.length === 0 ? "last" : "middle";
    const margins = solo ? { top: 0, bottom: -0.12 * sz } : spot === "first" ? { top: 0, bottom: -0.5 * sz } : spot === "last" ? { top: -0.48 * sz, bottom: -0.12 * sz } : { top: -0.4 * sz, bottom: -0.4 * sz };
    let y = 0;
    for (const row of leadRows) {
      row.top = y;
      y += row.height;
    }
    let heroTop = 0;
    if (hero) {
      y += margins.top;
      heroTop = y;
      y += H + margins.bottom;
    }
    for (const row of tailRows) {
      row.top = y;
      y += row.height;
    }
    const footMargin = 26 * u;
    const ruleTop = y + footMargin;
    const microTop = ruleTop + RULE_H * u + 16 * u;
    const height = microTop + MICRO_LINE * u;
    const blockTop = cy - height / 2;
    for (const row of [...leadRows, ...tailRows]) row.top += blockTop;

    let heroInfo: Layout["hero"] = null;
    if (hero) {
      // Alignment is worked in the cue's own reading direction: mirror the rows for a right-to-left cue.
      const mirror = (x: number) => (rtl ? 2 * cx - x : x);
      const heroLeft = cx - W / 2;
      let dx: number;
      if (solo) dx = 0;
      else if (spot === "first") {
        const row = tailRows[0]!;
        dx = mirror(rtl ? row.right : row.left) - (cx - W / 2) - 0.12 * W;
      } else if (spot === "last") {
        const row = leadRows[leadRows.length - 1]!;
        dx = mirror(rtl ? row.left : row.right) - (cx + W / 2) + 0.16 * W;
      } else dx = -0.1 * W;
      dx *= dir;
      void heroLeft;
      const reach = scriptReach(fs);
      const lo = safe.x1 + reach / 2 - cx;
      const hi = safe.x2 - reach / 2 - cx;
      dx = lo <= hi ? clamp(dx, lo, hi) : 0;
      heroInfo = { fs, W, H, top: heroTop + blockTop, dx, reach };
    }
    const lefts = [...leadRows, ...tailRows].map((row) => row.left);
    const rights = [...leadRows, ...tailRows].map((row) => row.right);
    if (heroInfo) {
      lefts.push(cx + heroInfo.dx - heroInfo.reach / 2);
      rights.push(cx + heroInfo.dx + heroInfo.reach / 2);
    }
    return {
      rows: [...leadRows, ...tailRows],
      hero: heroInfo,
      height,
      blockTop,
      foot: { ruleTop: ruleTop + blockTop, microTop: microTop + blockTop, left: Math.min(...lefts), right: Math.max(...rights) },
    };
  };

  let laid = layout(size);
  const maxHeight = safe.y2 - safe.y1;
  for (let pass = 0; pass < 8 && laid.height > maxHeight; pass++) {
    const k = (maxHeight / laid.height) * 0.99;
    size *= k;
    if (hero) scriptScale = fitScale(1.03 * scriptReach(SCRIPT_SCALE * size), safe.x2 - safe.x1);
    laid = layout(size);
  }
  const rows = laid.rows;
  const heroBox = laid.hero;

  // --- timeline: the push-in, the exit, and how long every word needs to land ---
  const pushFrom = cue.startMs - 80;
  const pushDur = Math.max(1, cue.endMs - cue.startMs);
  const capsAt = (at: number) => cue.words[at]!.startMs - 60;
  const lands = [
    ...capsIndices.map((at) => capsAt(at) + capsDuration(cue.words[at]!.text)),
    ...(hero ? [hero.startMs - 60 + scriptDuration(hero.text)] : []),
  ];
  const holdUntil = Math.max(...lands) + READABLE_MS;
  let exitTo = cue.endMs - 80;
  let exitFrom = exitTo - EXIT_MS;
  if (exitFrom < holdUntil) {
    // A late word keeps the poster up until it has been readable; the cue still leaves within 60 ms of the next one starting.
    const limit = cue.endMs + OVERLAP_MS;
    exitFrom = Math.min(holdUntil, limit - EXIT_MIN_MS);
    exitTo = Math.min(Math.max(exitTo, exitFrom + EXIT_MIN_MS), limit);
  }
  const exitDur = exitTo - exitFrom;
  const band = cueNumber * 10;
  const s = (t: number) => 1 + PUSH * prog(t, pushFrom, pushDur);
  const out = (t: number) => EASES.in(prog(t, exitFrom, exitDur));
  const placeX = (v: number, t: number) => cx + s(t) * (v - cx);
  const placeY = (v: number, t: number) => cy + s(t) * (v - cy) - EXIT_LIFT * u * out(t);

  /** Keyframes of `fn` over a piece's window, with the push-in and the exit's lift composed in. */
  const edgesOf = (from: number, to: number, extra: readonly number[]) => [...new Set([from, ...extra.filter((at) => at > from && at < to), ...[exitFrom, exitTo].filter((at) => at > from && at < to), to])].sort((a, b) => a - b);
  const framesX = (fn: (t: number) => number, from: number, to: number, extra: readonly number[] = []): Frames => sampleFrames((t) => placeX(fn(t), t), edgesOf(from, to, extra), 0.25);
  const framesY = (fn: (t: number) => number, from: number, to: number, extra: readonly number[] = []): Frames => sampleFrames((t) => placeY(fn(t), t), edgesOf(from, to, extra), 0.25);
  const scaleFrames = (fn: (t: number) => number, from: number, to: number, extra: readonly number[] = []): Frames => sampleFrames((t) => s(t) * fn(t), edgesOf(from, to, extra), 0.004);
  const exitOpacity = (fn: (t: number) => number, from: number, to: number, extra: readonly number[] = []): Frames => sampleFrames((t) => fn(t) * (1 - out(t)), edgesOf(from, to, extra), 0.01);
  const exitBlur = (fn: (t: number) => number, from: number, to: number, extra: readonly number[] = []): Frames =>
    sampleFrames((t) => Math.hypot(fn(t), EXIT_BLUR * u * out(t)), edgesOf(from, to, extra), 0.05);
  const rect = (x1: (t: number) => number, x2: (t: number) => number, y1: number, y2: number, from: number, to: number, extra: readonly number[] = []): Clip => ({
    x1: framesX(x1, from, to, extra),
    x2: framesX(x2, from, to, extra),
    y1: framesY(() => y1, from, to),
    y2: framesY(() => y2, from, to),
  });

  const pieces: Piece[] = [];
  const glow = mixColour(input.colours.primary, "#FFFFFF", GLOW_MIX);
  const capsShadow = [{ dx: 0, dy: 4 * u, blur: 5 * u, colour: SHADOW, alpha: 0.6 }] as const;
  const fromAll = cue.startMs - 60;

  // --- the caps: a left-to-right wipe with a blur settling and a glow that lights as the word lands ---
  const firstCaps = capsIndices.length > 0 ? Math.min(...capsIndices.map((at) => cue.words[at]!.startMs)) : cue.startMs;
  for (const row of rows) {
    const baseline = row.top + row.up;
    const boxTop = row.top - PAD * size;
    const boxBottom = row.top + row.height + PAD * size;
    for (const word of row.words) {
      const startAt = capsAt(word.index);
      const dur = capsDuration(cue.words[word.index]!.text);
      const from = Math.max(fromAll, startAt + 4);
      const to = exitTo;
      if (to <= from) continue;
      const left = word.left - PAD * size;
      const right = word.left + word.box + PAD * size;
      const width = right - left;
      const wipe = (t: number) => prog(t, startAt, dur);
      // Left to right (right to left for an RTL cue): the leading edge of the clip advances across the padded box.
      const clip = rtl
        ? rect((t) => right - wipe(t) * width, () => right, boxTop, boxBottom, from, to, [startAt, startAt + dur])
        : rect(() => left, (t) => left + wipe(t) * width, boxTop, boxBottom, from, to, [startAt, startAt + dur]);
      const entranceBlur = (t: number) => 6 * u * (1 - EASES.out(prog(t, startAt, 240)));
      const common = {
        kind: "text" as const,
        text: word.text,
        face: CAPS_FACE,
        sizePx: size,
        letterSpacingEm: capsLs(word.index),
        anchor: "baseline-left" as const,
        language: cue.language,
      };
      const glowEnd = startAt + dur * 0.5 + 520;
      const glowTo = Math.min(to, glowEnd);
      if (glowTo > from) {
        const glowAt = (t: number) => (t < startAt ? 0 : 1 - EASES.out(prog(t, startAt + dur * 0.5, 520)));
        pieces.push({
          ...common,
          id: `premiere:${cueNumber}:g${word.index}`,
          z: band + 1,
          fromMs: from,
          toMs: glowTo,
          track: {
            x: framesX(() => word.left, from, glowTo),
            y: framesY(() => baseline, from, glowTo),
            sx: scaleFrames(() => 1, from, glowTo),
            sy: scaleFrames(() => 1, from, glowTo),
            o: exitOpacity((t) => 0.95 * glowAt(t), from, glowTo, [startAt + dur * 0.5]),
            blur: exitBlur((t) => size * (0.06 + 0.04 * glowAt(t)), from, glowTo, [startAt + dur * 0.5]),
          },
          clip: rect(
            rtl ? (t) => right - wipe(t) * width : () => left,
            rtl ? () => right : (t) => left + wipe(t) * width,
            boxTop,
            boxBottom,
            from,
            glowTo,
            [startAt, startAt + dur],
          ),
          fill: glow,
        } satisfies TextPiece);
      }
      pieces.push({
        ...common,
        id: `premiere:${cueNumber}:w${word.index}`,
        z: band + 2,
        fromMs: from,
        toMs: to,
        track: {
          x: framesX(() => word.left, from, to),
          y: framesY(() => baseline, from, to),
          sx: scaleFrames(() => 1, from, to),
          sy: scaleFrames(() => 1, from, to),
          blur: exitBlur(entranceBlur, from, to, [startAt, startAt + 240]),
          ...(to > exitFrom ? { o: exitOpacity(() => 1, from, to) } : {}),
        },
        clip,
        fill: input.colours.primary,
        shadows: capsShadow,
      } satisfies TextPiece);
    }
  }

  // --- a sparkle: pops (spring + quarter turn) and twinkles while the cue holds ---
  const sparkle = (id: string, x: number, y: number, radius: number, popAt: number, z: number) => {
    const reach = radius * SPRING_PEAK * 1.3;
    const px = clamp(x, safe.x1 + reach, safe.x2 - reach);
    const py = clamp(y, safe.y1 + reach, safe.y2 - reach);
    const from = Math.max(fromAll, popAt + 4);
    if (exitTo <= from) return;
    const popEnd = popAt + 420;
    const twinkle = (t: number) => (t < popEnd ? 1 : 1 + 0.14 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (t - popEnd)) / TWINKLE_MS)));
    const pulses: number[] = [];
    for (let at = popEnd; at < Math.min(exitFrom, popEnd + 8 * TWINKLE_MS); at += TWINKLE_MS / 4) pulses.push(at);
    const scale = (t: number) => (t < popAt ? 0 : EASES.spring(prog(t, popAt, 420))) * twinkle(t);
    const path = SPARKLE_UNIT.map((cmd): PathCmd => {
      if (cmd[0] === "Z") return cmd;
      const k = radius / 50;
      if (cmd[0] === "C") return ["C", cmd[1] * k + radius, cmd[2] * k + radius, cmd[3] * k + radius, cmd[4] * k + radius, cmd[5] * k + radius, cmd[6] * k + radius];
      return [cmd[0], cmd[1] * k + radius, cmd[2] * k + radius];
    });
    const shape: ShapePiece = {
      id: `premiere:${cueNumber}:${id}`,
      kind: "shape",
      z,
      fromMs: from,
      toMs: exitTo,
      track: {
        x: framesX(() => px, from, exitTo),
        y: framesY(() => py, from, exitTo),
        sx: scaleFrames(scale, from, exitTo, [popAt, popEnd, ...pulses]),
        sy: scaleFrames(scale, from, exitTo, [popAt, popEnd, ...pulses]),
        rz: [[popAt, -60], [popEnd, 0, "spring"]],
        o: exitOpacity((t) => prog(t, popAt, 60), from, exitTo, [popAt, popAt + 60]),
      },
      origin: { dx: radius, dy: radius },
      path,
      fill: { colour: input.colours.accent },
    };
    pieces.push(shape);
  };

  // --- the script word: writes on across the stack, rises 14 px, tipped about the centre of its box ---
  if (heroBox && hero) {
    const { fs, W, H, top, dx } = heroBox;
    const startAt = hero.startMs - 60;
    const dur = scriptDuration(hero.text);
    const from = Math.max(fromAll, startAt + 4);
    const bx = cx + dx;
    const by = top + (H / 2);
    const baseline = top + (SCRIPT_PAD.top + SCRIPT_BASELINE) * fs;
    const box = { w: W * Math.cos(tiltRad) + H * Math.sin(tiltRad), h: H * Math.cos(tiltRad) + W * Math.sin(tiltRad) };
    const rise = (t: number) => 14 * u * (1 - EASES.out(prog(t, startAt, dur)));
    const write = (t: number) => EASES.inOut(prog(t, startAt, dur));
    const left = bx - box.w / 2;
    const right = bx + box.w / 2;
    const clip = rtl
      ? rect((t) => right - write(t) * box.w, () => right, by - box.h / 2, by + box.h / 2 + 14 * u, from, exitTo, [startAt, startAt + dur])
      : rect(() => left, (t) => left + write(t) * box.w, by - box.h / 2, by + box.h / 2 + 14 * u, from, exitTo, [startAt, startAt + dur]);
    const knockout = SCRIPT_KNOCKOUT_EM * fs;
    pieces.push({
      id: `premiere:${cueNumber}:hero`,
      kind: "text",
      z: band + 4,
      fromMs: from,
      toMs: exitTo,
      track: {
        x: framesX(() => bx, from, exitTo),
        y: framesY((t) => by + rise(t), from, exitTo, [startAt, startAt + dur]),
        sx: scaleFrames(() => 1, from, exitTo),
        sy: scaleFrames(() => 1, from, exitTo),
        rz: [[from, tilt]],
        ...(exitTo > exitFrom ? { o: exitOpacity(() => 1, from, exitTo), blur: exitBlur(() => 0, from, exitTo) } : {}),
      },
      clip,
      origin: { dx: 0, dy: by - baseline },
      text: hero.text,
      face: SCRIPT_FACE,
      sizePx: fs,
      letterSpacingEm: 0,
      fill: input.colours.highlight,
      stroke: { widthPx: knockout / 2, colour: KNOCKOUT },
      shadows: [{ dx: 0, dy: 6 * u, blur: 7 * u, colour: SHADOW, alpha: 0.5 }],
      anchor: "baseline-center",
      language: cue.language,
    });
    // The sparkle sits on a corner of the (unturned) script box, at the end of the stroke.
    const spot = HERO_SPOTS[heroCounter % HERO_SPOTS.length]!;
    const radius = SPARKLE_SIZES[heroCounter % SPARKLE_SIZES.length]! * u;
    const sideSign = (spot.startsWith("trail") ? 1 : -1) * dir;
    const sx = bx + sideSign * (W / 2 - 0.2 * fs);
    const sy = spot.endsWith("top") ? top + 0.2 * fs : top + H - 0.2 * fs;
    sparkle("star", sx, sy, radius, startAt + dur * 0.85, band + 5);
  } else {
    // No script word: a sparkle on one of the caps' corners, the cue's own recurring accent.
    const spot = PLAIN_SPOTS[plainCounter % PLAIN_SPOTS.length]!;
    const ordered = rows.flatMap((row) => row.words.map((word) => ({ word, row }))).sort((a, b) => a.word.index - b.word.index);
    const pick = spot.startsWith("first") ? ordered[0] : ordered[ordered.length - 1];
    if (pick) {
      const radius = SPARKLE_SIZES[plainCounter % SPARKLE_SIZES.length]! * u;
      const word = pick.word;
      const top = spot.endsWith("top");
      const trail = spot.startsWith("last") ? 1 : -1;
      const sx = word.left + word.box / 2 + trail * dir * (word.box / 2 - 0.04 * size);
      const baseline = pick.row.top + pick.row.up;
      const sy = top ? baseline - CAPS_CAP_HEIGHT * size - 0.05 * size : baseline + 0.05 * size;
      const startAt = capsAt(word.index);
      sparkle("star", sx, sy, radius, startAt + capsDuration(cue.words[word.index]!.text) * 0.85, band + 5);
    }
  }

  // --- the hairline and the credit line (the cue's clip time), under the first caps word ---
  const align = FOOT_ALIGNS[cueNumber % FOOT_ALIGNS.length]!;
  const ruleW = RULE_WIDTHS[cueNumber % RULE_WIDTHS.length]! * u;
  const ruleH = RULE_H * u;
  const footAt = Math.max(cue.startMs, firstCaps);
  const leadEdge = rtl ? laid.foot.right : laid.foot.left;
  const trailEdge = rtl ? laid.foot.left : laid.foot.right;
  // `end` is the rule's fixed end: its centre, its leading edge or its trailing edge.
  const ruleEnd = align === "center" ? cx : align === "lead" ? leadEdge : trailEdge;
  const ruleLeft = align === "center" ? cx - ruleW / 2 : (align === "lead") === !rtl ? ruleEnd : ruleEnd - ruleW;
  const pivotDx = align === "center" ? ruleW / 2 : ruleEnd - ruleLeft;
  const drawAt = footAt + 120;
  const drawFrom = Math.max(fromAll, drawAt + 8);
  const ruleTop = laid.foot.ruleTop;
  if (exitTo > drawFrom) {
    const draw = (t: number) => EASES.outExpo(prog(t, drawAt, 520));
    const shape: ShapePiece = {
      id: `premiere:${cueNumber}:rule`,
      kind: "shape",
      z: band + 3,
      fromMs: drawFrom,
      toMs: exitTo,
      track: {
        x: framesX(() => ruleLeft + pivotDx, drawFrom, exitTo),
        y: framesY(() => ruleTop + ruleH / 2, drawFrom, exitTo),
        sx: scaleFrames(draw, drawFrom, exitTo, [drawAt, drawAt + 520]),
        sy: scaleFrames(() => 1, drawFrom, exitTo),
        ...(exitTo > exitFrom ? { o: exitOpacity(() => 1, drawFrom, exitTo), blur: exitBlur(() => 0, drawFrom, exitTo) } : {}),
      },
      origin: { dx: pivotDx, dy: ruleH / 2 },
      path: rectPath(0, 0, ruleW, ruleH),
      fill: { colour: input.colours.accent },
      shadows: [{ dx: 0, dy: 2 * u, blur: 3 * u, colour: SHADOW, alpha: 0.5 }],
    };
    pieces.push(shape);
  }
  const microText = premiereTimestamp(cue.startMs);
  const microSize = MICRO_SIZE * u;
  const microAdvance = input.measure(microText, MICRO_FACE, microSize, MICRO_LS).advance;
  const microLeft = align === "center" ? cx - microAdvance / 2 : (align === "lead") === !rtl ? ruleEnd : ruleEnd - microAdvance;
  const typeAt = footAt + 220;
  const microFrom = Math.max(fromAll, typeAt + 4);
  const microTop = laid.foot.microTop;
  if (exitTo > microFrom) {
    const type = (t: number) => prog(t, typeAt, 420);
    const boxTop = microTop - 0.1 * microSize;
    const boxBottom = microTop + MICRO_LINE * u + 0.1 * microSize;
    const x1 = microLeft - 0.05 * microSize;
    const x2 = microLeft + microAdvance + MICRO_LS * microSize;
    const clip = rtl
      ? rect((t) => x2 - type(t) * (x2 - x1), () => x2, boxTop, boxBottom, microFrom, exitTo, [typeAt, typeAt + 420])
      : rect(() => x1, (t) => x1 + type(t) * (x2 - x1), boxTop, boxBottom, microFrom, exitTo, [typeAt, typeAt + 420]);
    pieces.push({
      id: `premiere:${cueNumber}:credit`,
      kind: "text",
      z: band + 3,
      fromMs: microFrom,
      toMs: exitTo,
      track: {
        x: framesX(() => microLeft, microFrom, exitTo),
        y: framesY(() => microTop + MICRO_BASELINE * microSize, microFrom, exitTo),
        sx: scaleFrames(() => 1, microFrom, exitTo),
        sy: scaleFrames(() => 1, microFrom, exitTo),
        o: exitOpacity(() => 0.88, microFrom, exitTo),
        ...(exitTo > exitFrom ? { blur: exitBlur(() => 0, microFrom, exitTo) } : {}),
      },
      clip,
      text: microText,
      face: MICRO_FACE,
      sizePx: microSize,
      letterSpacingEm: MICRO_LS,
      fill: input.colours.accent,
      shadows: [{ dx: 0, dy: 2 * u, blur: 3 * u, colour: SHADOW, alpha: 0.7 }],
      anchor: "baseline-left",
      language: null,
    });
  }
  return clampToSafeArea(pieces, safe, input.measure);
}

export const premiereProgram: SceneProgram = {
  build(input) {
    const counters = { hero: 0, plain: 0 };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, counters, input))) };
  },
};
