import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { SAFE_INSET, balancedRows, clampToSafeArea, cueDirection, fitScale, sceneSpace } from "../layout";
import type { Clip, Piece, ShapePiece, TextPiece } from "../scene";
import { ellipsePath, rectPath } from "../shapes";

/**
 * Wallpaper (`samples/templates/m09-wallpaper.js`): the caption sits on a soft pill in a wide heavy grotesk (Archivo
 * Expanded ExtraBold, capitals). The pill opens sideways from a circle and grows a row at a time as words land. On a hero
 * word the pill opens into a panel and the word multiplies into a low-contrast wallpaper of itself: strips above and below
 * the live line unfold from it, two frames apart, and drift sideways in alternating directions, while the hero types on
 * letter by letter in the bright colour with a small spring bounce. Two colourways, charcoal and cream, in pairs of cues.
 *
 * What changed from the sample, and why (gallery 2 brief, 2026-11-21):
 * - Colourway by cue counter (`floor(n / 2) % 2`: charcoal, charcoal, cream, cream, ...), which is exactly the sample's
 *   `LINES` table for its five cues and works for any clip. The cream hero is the highlight darkened 18 % (the sample's
 *   `#D9543A` beside `#FF6B43`), the wall colour a tint derived from the hero's hue (warm grey-brown on charcoal, its
 *   complement on cream: the sample's `#4C3F37` and `#A5D6D1`), so a brand colour recolours the whole look.
 * - Hero cues recur with two variants by a hero counter: the sample's (copies lined up with the live hero, rows unfolding
 *   outward from the live line) and a brick variant (odd rows shifted half a pitch, rows unfolding top to bottom, drift
 *   reversed). Drift speed carries +-15 % from a hash of the cue's index and text. A cue without a hero keeps the plain
 *   pill, its words rising from below or dropping from above on alternate cues.
 * - The wallpaper's copies are laid out from the panel, not from a fixed nine: only the copies that cross the panel during
 *   the cue exist (a short hero word no longer leaves bare panel at its edges, the sample's nine copies cover 8 pitches).
 * - Fit: the sample forces a hero cue onto one row with no size floor and never wraps a word. Here the size falls to
 *   `WRAP / natural width` as before, down to 60 px; below that the cue wraps evenly (the wallpaper then fills the rows above
 *   and below the text block); a single word wider than a row shrinks the cue. The wrap width and the panel are limited
 *   to the safe area for any size scale and canvas (16:9, 1:1), and the wallpaper's rows are cut down when a tall block
 *   would not fit the frame.
 * - Real speech timing: `cueGap: 380` is demo pacing. The exit (200 ms, group scale 0.94 and fade) never starts before the
 *   last word has been on screen 160 ms, unless the cue ends sooner (then it is gone 40 ms after its end: the next cue
 *   is entering); the hero's typing is squeezed into the time the cue has (8 ms a letter at the least).
 * - Scripts: letters type on one by one only for left-to-right Latin, Cyrillic and Greek words without combining marks;
 *   every other script's hero word takes the same spring as a whole word. Capitals apply only to those cased scripts.
 *   Right-to-left cues build their rows from the right.
 * - The panel is a rounded rectangle whose radius and size change every frame: six pieces (four discs, two bands) sampled from
 *   the sample's own rect function. Its `box-shadow` (0 18px 44px) is dropped: a blurred card-sized layer is the kind of
 *   cost the budget measures, and it is invisible on the dark footage the sample is judged on.
 * - `no-hero` balanced rows: a cue's rows wrap evenly (`text-wrap: balance`) instead of the sample's greedy fill.
 */

export const WALLPAPER_DEMO: DemoScript = {
  lines: [
    "stop:b chasing:b every:b new:b trend",
    "pick:b ONE:h@560 idea:b",
    "and:m say:b it:m again:b+120",
    "and:m AGAIN:h@620",
    "until:m it:m STICKS:h@640+120",
  ],
  options: { rate: 270, cueGap: 380, tail: 900 },
};

const FACE = "Archivo Expanded ExtraBold" as const;
const LS = -0.005;
/** Chrome puts the baseline of a `line-height: 1` Archivo Expanded ExtraBold box at 0.829 em (58 of 70 px, 83 of 100). */
const BASE_EM = 0.829;
const CX = 540;
const CY = 1290;
const SIZE = 70;
const HERO_SIZE = 100;
const HERO_FLOOR = 60;
const WRAP = 820;
const PADX = 46;
const PADY = 22;
const BAND_W = 880;
const BAND_ROWS = 2;
const DRIFT = 70;
const EXIT = 200;
const EXIT_MIN = 60;
/** The hero is on screen this long before the cue may start to leave. */
const READ_MS = 160;
const PANEL_RADIUS = 34;
const COPY_CAP = 84;

const CHARCOAL_WALL = { s: 0.16, l: 0.26 } as const;
const CREAM_WALL = { s: 0.4, l: 0.76, turn: 163 } as const;
const CREAM_HERO_DARKEN = 0.18;

interface Scheme {
  panel: string;
  text: string;
  hero: string;
  wall: string;
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

function hex(values: readonly number[]): string {
  return `#${values.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function hueOf(colour: string): number {
  const [r, g, b] = rgb(colour).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return hex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/** The two colourways (spec: charcoal and cream) from the preset's three colours: light = primary, dark = accent, hero = highlight. */
export function wallpaperSchemes(colours: { primary: string; highlight: string; accent: string }): [Scheme, Scheme] {
  const hue = hueOf(colours.highlight);
  const dark = rgb(colours.highlight).map((v) => v * (1 - CREAM_HERO_DARKEN));
  return [
    { panel: colours.accent, text: colours.primary, hero: colours.highlight, wall: fromHsl(hue, CHARCOAL_WALL.s, CHARCOAL_WALL.l) },
    { panel: colours.primary, text: colours.accent, hero: hex(dark), wall: fromHsl((hue + CREAM_WALL.turn) % 360, CREAM_WALL.s, CREAM_WALL.l) },
  ];
}

/** A deterministic 0..1 from a cue's index and text (FNV-1a). */
export function wallpaperHash(text: string): number {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

const CASED = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{S}\p{M}\s]+$/u;
const SIMPLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{S}]+$/u;

function capitals(text: string, language: string | null): string {
  if (!CASED.test(text)) return text;
  try {
    return text.toLocaleUpperCase(language ?? undefined);
  } catch {
    return text.toUpperCase();
  }
}

interface Item {
  index: number;
  text: string;
  w: number;
  /** Distance from the row's leading edge to the word's near edge. */
  xIn: number;
  row: number;
  startMs: number;
  hero: boolean;
  letters: { ch: string; w: number }[] | null;
}

interface Row {
  items: Item[];
  start: number;
  right: number[];
}

interface State {
  s: number;
  m: number;
  rowW: number[];
  rowY: number[];
  rowsShown: number;
  w: number;
  h: number;
  rad: number;
  open: number;
}

function buildCue(cue: SceneCue, cueNumber: number, heroNumber: number, plainNumber: number, input: SceneInput): Piece[] {
  const space = sceneSpace(input, CY);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const schemes = wallpaperSchemes(input.colours);
  const scheme = schemes[Math.floor(cueNumber / 2) % 2]!;
  const band = cueNumber * 10;
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const hasHero = heroAt >= 0;
  const jitter = wallpaperHash(`${cue.index}:${cue.words.map((word) => word.text).join(" ")}`);

  // The zone, in sample px: the wrap width and the panel never pass the safe area, at any size scale or canvas.
  const safeW = (input.canvas.width * (1 - 2 * SAFE_INSET)) / u;
  const safeH = (input.canvas.height * (1 - 2 * SAFE_INSET)) / u;
  const wrapW = Math.min(WRAP, safeW - 2 * PADX - 4);
  const bandW = Math.min(BAND_W, safeW - 4);
  // A hero cue's one row is `WRAP` long by the sample's own spaces; its gaps are 1.15 spaces, so the row may run a little over.
  const rowLimit = Math.min(wrapW + 24, safeW - 2 * PADX - 4);

  const display = cue.words.map((word) => capitals(word.text, cue.language));
  const measure = (text: string, size: number) => input.measure(text, FACE, size * u, LS).advance / u + LS * size;
  const split = display.map((text, at) => cue.words[at]!.role === "hero" && !rtl && SIMPLE.test(text) && [...text].length <= 24);
  const wordW = (at: number, size: number) => (split[at] ? [...display[at]!].reduce((sum, ch) => sum + measure(ch, size), 0) : measure(display[at]!, size));

  // --- size and rows ---
  const space100 = measure("A B", 100) - measure("AB", 100);
  let size = SIZE;
  if (hasHero) {
    const natural = (display.reduce((sum, _, at) => sum + wordW(at, 100), 0) + space100 * (display.length - 1)) / 100;
    size = Math.max(HERO_FLOOR, Math.min(HERO_SIZE, wrapW / natural));
  }
  let gap = (space100 / 100) * size * 1.15;
  let widths = display.map((_, at) => wordW(at, size));
  let rowIndexes = balancedRows(widths, gap, rowLimit);
  const widest = Math.max(...rowIndexes.map((row) => row.reduce((sum, at) => sum + widths[at]!, 0) + gap * (row.length - 1)));
  if (widest > rowLimit) {
    size *= fitScale(widest, rowLimit) * 0.995;
    gap = (space100 / 100) * size * 1.15;
    widths = display.map((_, at) => wordW(at, size));
    rowIndexes = balancedRows(widths, gap, rowLimit);
  }
  const lineH = size * 1.06;
  const items: Item[] = [];
  const rows: Row[] = rowIndexes.map((indexes, r) => {
    let x = 0;
    const row: Row = { items: [], start: cue.words[indexes[0]!]!.startMs, right: [] };
    for (const at of indexes) {
      const item: Item = {
        index: at,
        text: display[at]!,
        w: widths[at]!,
        xIn: x,
        row: r,
        startMs: cue.words[at]!.startMs,
        hero: cue.words[at]!.role === "hero",
        letters: split[at] ? [...display[at]!].map((ch) => ({ ch, w: measure(ch, size) })) : null,
      };
      x += item.w + gap;
      row.items.push(item);
      row.right.push(item.xIn + item.w);
      items[at] = item;
    }
    return row;
  });
  const R = rows.length;
  let bandRows = BAND_ROWS;
  while (bandRows > 0 && ((2 * bandRows + R) * lineH + 2 * PADY) > safeH) bandRows--;
  const bandH = (2 * bandRows + R) * lineH + 2 * PADY;
  const heroItem = hasHero ? items[heroAt]! : null;
  const heroStart = heroItem?.startMs ?? 0;

  // --- timing: the cue leaves once its last word has been on screen long enough ---
  const typed = items.filter((item) => item.letters);
  const letterStep = (item: Item) => Math.min(55, 240 / item.letters!.length, Math.max(8, (cue.endMs - READ_MS - 40 - (item.startMs - 60)) / item.letters!.length));
  const lands = items.map((item) => (item.letters ? item.startMs - 60 + (item.letters.length - 1) * letterStep(item) : item.startMs));
  // ... but it is gone 40 ms after the cue's end whatever happens: the next cue is entering over it (a successor that starts
  // within 160 ms of the last word shortens the read, never the hand-over).
  const exitFrom = Math.min(Math.max(cue.endMs - EXIT, Math.max(...lands) + READ_MS), cue.endMs - 20);
  const exitDur = clamp(cue.endMs + 40 - exitFrom, EXIT_MIN, EXIT);
  const exitEnd = exitFrom + exitDur;
  const fromMs = cue.startMs - 80;

  // --- the sample's state at time t, in sample px ---
  const memo = new Map<number, State>();
  const stateAt = (t: number): State => {
    const cached = memo.get(t);
    if (cached) return cached;
    const s = lerp(1, 0.94, EASES.in(prog(t, exitFrom, exitDur)));
    const m = 1 - EASES.in(prog(t, exitFrom + exitDur * 0.4, exitDur * 0.6));
    let rowsShown = 0;
    for (const row of rows) rowsShown += EASES.outExpo(prog(t, row.start - 80, 260));
    const rowW = rows.map((row) => {
      if (t < row.start - 80) return 0;
      let w = row.right[0]!;
      for (let k = 1; k < row.items.length; k++) w += (row.right[k]! - row.right[k - 1]!) * EASES.outExpo(prog(t, row.items[k]!.startMs - 80, 280));
      return w;
    });
    const rowY = rows.map((_, r) => CY - (Math.max(1, rowsShown) * lineH) / 2 + r * lineH);
    const pillW = Math.max(0, ...rowW) + PADX * 2;
    const pillH = Math.max(1, rowsShown) * lineH + PADY * 2;
    const open = hasHero ? EASES.outExpo(prog(t, heroStart - 60, 360)) * (1 - EASES.inOut(prog(t, exitFrom, exitDur * 0.8))) : 0;
    const pw = lerp(pillW, Math.max(pillW, bandW), open);
    const ph = lerp(pillH, bandH, open);
    const w = lerp(pillH, pw, EASES.outExpo(prog(t, cue.startMs - 80, 300)));
    const rad = Math.min(lerp(pillH / 2, PANEL_RADIUS, open), w / 2, ph / 2);
    const state: State = { s, m, rowW, rowY, rowsShown, w, h: ph, rad, open };
    memo.set(t, state);
    return state;
  };
  const leftOf = (item: Item, st: State) => {
    const w = st.rowW[item.row]!;
    return rtl ? CX + w / 2 - item.xIn - item.w : CX - w / 2 + item.xIn;
  };
  const mx = (x: number, s: number) => space.x(CX + s * (x - CX));
  const my = (y: number, s: number) => space.y(CY + s * (y - CY));
  const mapped = (fn: (t: number, st: State) => number, map: "x" | "y") => (t: number) => {
    const st = stateAt(t);
    return (map === "x" ? mx : my)(fn(t, st), st.s);
  };

  // --- sampling ---
  const edgeSet = new Set<number>([fromMs, fromMs + 300, exitFrom, exitEnd, exitFrom + exitDur * 0.4, exitFrom + exitDur * 0.7, exitFrom + exitDur * 0.8]);
  for (const row of rows) {
    edgeSet.add(row.start - 80);
    edgeSet.add(row.start - 80 + 260);
    for (const item of row.items) {
      edgeSet.add(item.startMs - 80);
      edgeSet.add(item.startMs - 80 + 280);
      edgeSet.add(item.startMs - 60);
      edgeSet.add(item.startMs - 60 + 240);
      edgeSet.add(item.startMs - 60 + 300);
    }
  }
  for (const item of typed) {
    const step = letterStep(item);
    item.letters!.forEach((_, i) => {
      edgeSet.add(item.startMs - 60 + i * step);
      edgeSet.add(item.startMs - 60 + i * step + 300);
    });
  }
  if (hasHero) {
    edgeSet.add(heroStart - 60);
    edgeSet.add(heroStart - 60 + 360);
  }
  const sample = (fn: (t: number) => number, from: number, to: number, tolerance: number, extra: readonly number[] = []): Frames =>
    sampleFrames(fn, [...edgeSet, ...extra], tolerance, { range: [from, to], wholeMs: true, simplify: true });
  const POS = 0.3;
  const SCALE = 0.003;
  const OPACITY = 0.012;
  const pieces: Piece[] = [];
  const language = cue.language;

  // --- the panel: four discs and two bands, sampled from the rect ---
  const panelFill = { colour: scheme.panel };
  const intervals = (pred: (st: State) => boolean): [number, number][] => {
    const out: [number, number][] = [];
    let open: number | null = null;
    for (let t = fromMs; t <= exitEnd; t++) {
      const on = pred(stateAt(t));
      if (on && open === null) open = t;
      if (!on && open !== null) {
        out.push([open, t]);
        open = null;
      }
    }
    if (open !== null) out.push([open, exitEnd]);
    return out;
  };
  const DISC = 100;
  const disc = (name: string, dx: -1 | 1, dy: -1 | 1) => {
    pieces.push({
      id: `wallpaper:${cueNumber}:${name}`,
      kind: "shape",
      z: band + 1,
      fromMs,
      toMs: exitEnd,
      track: {
        x: sample(mapped((_, st) => CX + dx * (st.w / 2 - st.rad), "x"), fromMs, exitEnd, POS),
        y: sample(mapped((_, st) => CY + dy * (st.h / 2 - st.rad), "y"), fromMs, exitEnd, POS),
        sx: sample((t) => (2 * space.px(stateAt(t).rad * stateAt(t).s)) / DISC, fromMs, exitEnd, SCALE),
        sy: sample((t) => (2 * space.px(stateAt(t).rad * stateAt(t).s)) / DISC, fromMs, exitEnd, SCALE),
        o: sample((t) => stateAt(t).m, fromMs, exitEnd, OPACITY),
      },
      origin: { dx: DISC / 2, dy: DISC / 2 },
      path: ellipsePath(DISC / 2, DISC / 2, DISC / 2),
      fill: panelFill,
    } satisfies ShapePiece);
  };
  disc("tl", -1, -1);
  disc("tr", 1, -1);
  disc("bl", -1, 1);
  disc("br", 1, 1);
  const bandPiece = (name: string, pred: (st: State) => boolean, width: (st: State) => number, height: (st: State) => number) => {
    intervals(pred).forEach(([from, to], at) => {
      if (to - from < 2) return;
      pieces.push({
        id: `wallpaper:${cueNumber}:${name}${at}`,
        kind: "shape",
        z: band + 1,
        fromMs: from,
        toMs: to,
        track: {
          x: sample(mapped(() => CX, "x"), from, to, POS),
          y: sample(mapped(() => CY, "y"), from, to, POS),
          sx: sample((t) => space.px(width(stateAt(t)) * stateAt(t).s) / DISC, from, to, SCALE),
          sy: sample((t) => space.px(height(stateAt(t)) * stateAt(t).s) / DISC, from, to, SCALE),
          o: sample((t) => stateAt(t).m, from, to, OPACITY),
        },
        origin: { dx: DISC / 2, dy: DISC / 2 },
        path: rectPath(0, 0, DISC, DISC),
        fill: panelFill,
      } satisfies ShapePiece);
    });
  };
  const SLIVER = 0.8 / u;
  bandPiece("v", (st) => st.w - 2 * st.rad >= SLIVER, (st) => st.w - 2 * st.rad, (st) => st.h);
  bandPiece("h", (st) => st.h - 2 * st.rad >= SLIVER, (st) => st.w, (st) => st.h - 2 * st.rad);

  // --- the words ---
  const plainDir = plainNumber % 2 === 0 ? 1 : -1;
  for (const row of rows) {
    for (const item of row.items) {
      const word = cue.words[item.index]!;
      const baseY = (st: State) => st.rowY[item.row]! + BASE_EM * size;
      if (item.letters) {
        const step = letterStep(item);
        let offset = 0;
        item.letters.forEach((letter, i) => {
          const at = item.startMs - 60 + i * step;
          const lead = offset;
          offset += letter.w;
          if (!letter.ch.trim()) return;
          pieces.push({
            id: `wallpaper:${cueNumber}:w${item.index}l${i}`,
            kind: "text",
            z: band + 3,
            fromMs: at,
            toMs: exitEnd,
            track: {
              x: sample(mapped((_, st) => leftOf(item, st) + lead, "x"), at, exitEnd, POS),
              y: sample(mapped((t, st) => baseY(st) + (1 - EASES.spring(prog(t, at, 300))) * size * 0.22, "y"), at, exitEnd, POS),
              sx: sample((t) => stateAt(t).s, at, exitEnd, SCALE),
              sy: sample((t) => stateAt(t).s, at, exitEnd, SCALE),
              o: sample((t) => stateAt(t).m, at, exitEnd, OPACITY),
            },
            text: letter.ch,
            face: FACE,
            sizePx: size * u,
            letterSpacingEm: LS,
            fill: scheme.hero,
            anchor: "baseline-left",
            language,
          } satisfies TextPiece);
        });
        continue;
      }
      const at = word.startMs - 60;
      pieces.push({
        id: `wallpaper:${cueNumber}:w${item.index}`,
        kind: "text",
        z: band + 3,
        fromMs: at,
        toMs: exitEnd,
        track: {
          x: sample(mapped((_, st) => leftOf(item, st), "x"), at, exitEnd, POS),
          y: item.hero
            ? sample(mapped((t, st) => baseY(st) + (1 - EASES.spring(prog(t, at, 300))) * size * 0.22, "y"), at, exitEnd, POS)
            : sample(mapped((t, st) => baseY(st) + plainDir * (1 - EASES.outExpo(prog(t, at, 240))) * size * 0.2, "y"), at, exitEnd, POS),
          sx: sample((t) => stateAt(t).s, at, exitEnd, SCALE),
          sy: sample((t) => stateAt(t).s, at, exitEnd, SCALE),
          o: item.hero ? sample((t) => stateAt(t).m, at, exitEnd, OPACITY) : sample((t) => clamp(EASES.outExpo(prog(t, at, 240)) * 3) * stateAt(t).m, at, exitEnd, OPACITY),
        },
        text: item.text,
        face: FACE,
        sizePx: size * u,
        letterSpacingEm: LS,
        fill: item.hero ? scheme.hero : scheme.text,
        anchor: "baseline-left",
        language,
      } satisfies TextPiece);
    }
  }

  // --- the wallpaper: strips of the hero word above and below the text block ---
  if (heroItem) {
    const variant = heroNumber % 2;
    const speed = DRIFT * (0.85 + 0.3 * jitter);
    const slots = [-2, -1, 1, 2].filter((k) => Math.abs(k) <= bandRows);
    const innerClip = (t: number) => {
      const st = stateAt(t);
      const inset = Math.min(st.rad, PANEL_RADIUS) * 0.6;
      return { x1: CX - st.w / 2 + inset, x2: CX + st.w / 2 - inset, y1: CY - st.h / 2 + 12, y2: CY + st.h / 2 - 12, s: st.s };
    };
    const clip: Clip = {
      x1: sample((t) => mx(innerClip(t).x1, innerClip(t).s), fromMs, exitEnd, POS),
      x2: sample((t) => mx(innerClip(t).x2, innerClip(t).s), fromMs, exitEnd, POS),
      y1: sample((t) => my(innerClip(t).y1, innerClip(t).s), fromMs, exitEnd, POS),
      y2: sample((t) => my(innerClip(t).y2, innerClip(t).s), fromMs, exitEnd, POS),
    };
    const startOf = (k: number) => heroStart - 20 + (variant === 0 ? Math.abs(k) - 1 : slots.indexOf(k)) * 60;
    const unfold = (k: number) => (t: number) => EASES.outExpo(prog(t, startOf(k), 240)) * (1 - EASES.in(prog(t, exitFrom, exitDur * 0.7)));
    const heroLeft = (t: number) => leftOf(heroItem, stateAt(t));
    const dirOf = (k: number) => (variant === 0 ? 1 : -1) * (Math.abs(k) % 2 === 0 ? -1 : 1);
    const driftOf = (k: number) => (t: number) => dirOf(k) * (Math.max(0, t - startOf(k)) / 1000) * speed;
    const phaseOf = (pitch: number, k: number) => (variant === 1 && Math.abs(k) % 2 === 1 ? pitch / 2 : 0);

    // The copies that cross the panel while the strip is drawn: scan the cue, grow the pitch if there would be too many.
    const copyW = measure(heroItem.text, size);
    type Copy = { k: number; c: number; from: number; to: number };
    const coverage = (pitch: number): Copy[] => {
      const found = new Map<string, Copy>();
      for (const k of slots) {
        const start = startOf(k);
        for (let t = start; t <= exitEnd; t += 20) {
          const live = unfold(k)(t) > 0.03 || t < start + 30;
          if (!live) continue;
          const clipNow = innerClip(t);
          const base = heroLeft(t) + phaseOf(pitch, k) + driftOf(k)(t);
          const lo = Math.ceil((clipNow.x1 - copyW - base) / pitch);
          const hi = Math.floor((clipNow.x2 - base) / pitch);
          for (let c = lo; c <= hi; c++) {
            const key = `${k}:${c}`;
            const seen = found.get(key);
            if (seen) seen.to = t;
            else found.set(key, { k, c, from: t, to: t });
          }
        }
      }
      return [...found.values()];
    };
    let pitch = heroItem.w + gap * 1.6;
    let copies = coverage(pitch);
    for (let tries = 0; copies.length > COPY_CAP && tries < 8; tries++) {
      pitch *= 1.25;
      copies = coverage(pitch);
    }
    for (const { k, c, from: seen, to: last } of copies) {
      const start = startOf(k);
      const from = Math.max(start + 3, seen - 40);
      const to = Math.min(exitEnd, last + 40);
      if (to - from < 2) continue;
      const above = k < 0;
      const topOf = (st: State) => (above ? st.rowY[0]! : st.rowY[R - 1]!) + k * lineH;
      const strip = unfold(k);
      pieces.push({
        id: `wallpaper:${cueNumber}:s${k < 0 ? "u" : "d"}${Math.abs(k)}c${c < 0 ? `m${-c}` : c}`,
        kind: "text",
        z: band + 2,
        fromMs: from,
        toMs: to,
        track: {
          x: sample(mapped((t) => heroLeft(t) + phaseOf(pitch, k) + c * pitch + driftOf(k)(t), "x"), from, to, POS, [start, start + 240]),
          y: sample(mapped((_, st) => topOf(st) + (above ? size : 0), "y"), from, to, POS, [start, start + 240]),
          sx: sample((t) => stateAt(t).s, from, to, SCALE),
          sy: sample((t) => Math.max(0.03, strip(t)) * stateAt(t).s, from, to, SCALE, [start, start + 240]),
          o: sample((t) => stateAt(t).m, from, to, OPACITY),
        },
        clip,
        origin: { dx: 0, dy: space.px(above ? (1 - BASE_EM) * size : -BASE_EM * size) },
        text: heroItem.text,
        face: FACE,
        sizePx: size * u,
        letterSpacingEm: LS,
        fill: scheme.wall,
        anchor: "baseline-left",
        language,
      } satisfies TextPiece);
    }
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const wallpaperProgram: SceneProgram = {
  build(input) {
    let heroNumber = 0;
    let plainNumber = 0;
    const pieces: Piece[] = [];
    input.cues.forEach((cue, number) => {
      if (cue.words.length === 0) return;
      const hero = cue.words.some((word) => word.role === "hero");
      pieces.push(...buildCue(cue, number, hero ? heroNumber : 0, hero ? 0 : plainNumber, input));
      if (hero) heroNumber++;
      else plainNumber++;
    });
    return { pieces };
  },
};
