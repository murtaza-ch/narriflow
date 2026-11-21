import { captionColourContrast } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { type Ease, type Frames, EASES, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { Clip, PathCmd, Piece, ShapePiece, TextPiece } from "../scene";
import { ellipsePath, pathBounds, polygonPath, polylinePath, rectPath, roundedRectPath } from "../shapes";

/**
 * Verified (`samples/templates/m02-verified.js`, after Motion Array "Typography Slides"): heavy wide italic capitals,
 * every word wiped on left to right behind a block cursor. The hero wipes in as three stacked rows, the outer two
 * hollow out into outline echoes, a tilted colour pill shoots in under it and types the rest of the line, and a
 * starburst check badge pops on its corner while two sparkles twinkle on the other side.
 *
 * What changed from the sample, and why (gallery 2 brief):
 * - Every row fits. The sample sets the pill and the lead and trail rows at 70 / 50 px with `nowrap` and no fit, and
 *   plain rows wrap only by flex; here a row shrinks to a floor (0.78, the pill's text 0.72) and then wraps evenly
 *   (`balancedRows`), the hero keeps its 860 px fit (no floor: a long word just gets smaller), and the pill wraps its
 *   text onto two lines when the line would not fit.
 * - Nothing leaves the 5 % safe area: the left sparkle and the badge are clamped inside it (the sample's sparkle sits
 *   at x 21 on a wide hero and the badge past x 1040), the cursor is cut at the safe edge, the pill is capped at 880 px.
 * - The exit never hides a word early. The sample wipes the block away for the last 160 ms before `end - 80`; real
 *   cues are 60 ms apart, so the wipe waits until the last word has landed and been readable for 150 ms, and is
 *   shortened (to a cut at worst) when the next cue is that close. It runs between the content's own edges, not the
 *   sample's fixed 920 px block, so it does not idle before touching a narrow cue.
 * - Recurrence. The pill's colour cycles over four palettes by hero counter (the sample's), and so do three things
 *   the sample drew once: the pill's tilt and the side it shoots in from (-7 or +5 degrees, a hash of the cue adds up
 *   to a degree), the badge's corner and the sparkles' side swap every other hero cue. A hero without trailing words
 *   gets the pill too (the star and the check, no text). A cue without a hero (the sample draws nothing but the
 *   wipe) gets a small check badge and one sparkle on its first or last word, cycling on its own counter. The sparkles
 *   keep twinkling for as long as the cue is held.
 * - Every language. Case is only changed for Latin, Greek and Cyrillic words; no word is ever split into letters; a
 *   right-to-left cue is mirrored (words ordered by the bidi code, wipes and cursors from the right, the pill's icons,
 *   typing and tilt, the badge's side, the exit running right to left); the hero's middle row is not cut at the
 *   sample's line box, so tall scripts keep their ink.
 * - Cheaper equivalents: the two-layer text shadow (22 px and 4 px) is one blurred layer, the pill's `box-shadow` a
 *   blurred copy of its body; the echo's hollowing fades its fill piece while a separate 0.7-alpha outline piece stays.
 * - The pill's outBack uses the sample's overshoot (1.4), so its position is sampled from that curve.
 */

export const VERIFIED_DEMO: DemoScript = {
  lines: [
    "I:m tried:b every:m morning:b routine",
    "only:m one:m stuck:h@520 for:m a:m year",
    "no:m alarm:b no:m phone",
    "just:m sunlight:h@600 and:m water",
    "try:b it:m tomorrow:h@620",
  ],
  options: { rate: 270 },
};

const ANCHOR_Y = 1280;
const CX = 540;
const INK_FACE = "Archivo Expanded Black Italic" as const;
const LEAD_FACE = "Archivo Expanded ExtraBold Italic" as const;
const LS = -0.01;
const PAD = 0.08;
const LINE_H = 0.84;
const PLAIN_SIZE = 84;
const PLAIN_GAP = 6;
const PLAIN_ROW_GAP = 10;
const LEAD_SIZE = 70;
const LEAD_GAP = 4;
const LEAD_ROW_GAP = 8;
const LEAD_MARGIN = 16;
const HERO_MAX = 220;
const HERO_FIT = 860;
const ROW_LIMIT = 920;
const ROW_FLOOR = 0.78;
const PILL_SIZE = 50;
const PILL_MAX = 880;
const PILL_CHROME = 158;
const PILL_FLOOR = 0.72;
const PILL_GAP_EM = 0.28;
const WRAP_MS = 260;
const HERO_WRAP_MS = 380;
const PRIMARY_ALPHA = 0.7;
const RING_EM = 0.016;
const SHADOW_ALPHA = 0.55;
const DARK = "#141414";
const RED = "#FF3B3B";
const GREEN = "#2CF07A";
const READ_MS = 158;
const EXIT_MS = 160;
const MIN_EXIT_MS = 12;
/** Progress at which an eased window has reached 99 %: outExpo (1 - 2^-10p) and `out` ((1 - p)^3 = 0.01). */
const P99_EXPO = Math.log2(100) / 10;
const P99_OUT = 1 - 0.01 ** (1 / 3);
const SPRING_PEAK = Math.max(...Array.from({ length: 201 }, (_, at) => EASES.spring(at / 200)));
const BADGE_POINTS = 11;

/** The sample's outBack with its overshoot of 1.4 (the engine's is 1.70158). */
const outBack14 = (p: number) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2;

/** Chrome's baseline of a `line-height: lh` box of Archivo (ascent 0.878, descent 0.21, each rounded, the sum floored). */
export function verifiedBaseline(size: number, lh: number): number {
  const ascent = Math.round(0.878 * size);
  const descent = Math.round(0.21 * size);
  return Math.floor((lh * size - (ascent + descent)) / 2 + ascent);
}

const OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]/u;
/** The sample sets everything in capitals; only cased scripts take that (Arabic, Devanagari, CJK ... keep their letters). */
export function verifiedCase(text: string): string {
  return OTHER_SCRIPT.test(text) ? text : text.toUpperCase();
}

/** A stable number in [0, 1) from a cue's index and text (FNV-1a), for small jitter that must not change between builds. */
export function verifiedHash(cue: Pick<SceneCue, "index" | "words">): number {
  let h = 2166136261;
  for (const ch of `${cue.index}:${cue.words.map((word) => word.text).join(" ")}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

/** The sample's four pill palettes: pill colour and the badge it wears. The pill's ink and the check come from contrast. */
export function verifiedPalette(colours: { highlight: string; accent: string }, n: number): { pill: string; badge: string } {
  return [
    { pill: colours.highlight, badge: colours.accent },
    { pill: colours.accent, badge: RED },
    { pill: RED, badge: colours.accent },
    { pill: GREEN, badge: RED },
  ][((n % 4) + 4) % 4]!;
}

const inkOn = (colour: string) => (captionColourContrast(colour, DARK) >= captionColourContrast(colour, "#FFFFFF") ? DARK : "#FFFFFF");

/** The wipe-away: when it starts and ends. It waits for every word to have landed and been readable for `READ_MS`. */
export function verifiedExit(cue: SceneCue, readyAt: number): { from: number; to: number } {
  const end = cue.endMs - 70;
  const wanted = Math.max(end - EXIT_MS, readyAt + READ_MS);
  // The next cue may start before the last word has been readable (overlapping cues): the cue is gone 40 ms after it starts, as a cut at worst.
  const to = Math.min(Math.max(end, wanted + MIN_EXIT_MS), cue.endMs + 40);
  return { from: Math.min(wanted, to - MIN_EXIT_MS), to };
}

/** A path drawn from its own top-left with its pivot in `origin`: libass places a drawing by its box. */
function anchored(path: readonly PathCmd[]): { path: PathCmd[]; origin: { dx: number; dy: number }; w: number; h: number } {
  const box = pathBounds(path);
  const moved = path.map((cmd): PathCmd => {
    if (cmd[0] === "Z") return cmd;
    if (cmd[0] === "C") return ["C", cmd[1] - box.x1, cmd[2] - box.y1, cmd[3] - box.x1, cmd[4] - box.y1, cmd[5] - box.x1, cmd[6] - box.y1];
    return [cmd[0], cmd[1] - box.x1, cmd[2] - box.y1];
  });
  return { path: moved, origin: { dx: -box.x1, dy: -box.y1 }, w: box.x2 - box.x1, h: box.y2 - box.y1 };
}

/** The sample's four-pointed sparkle (cubic waist of 0.22 r), centred on (0, 0). */
export function verifiedSparkle(r: number): PathCmd[] {
  const k = r * 0.22;
  return [["M", 0, -r], ["C", k, -k, k, -k, r, 0], ["C", k, k, k, k, 0, r], ["C", -k, k, -k, k, -r, 0], ["C", -k, -k, -k, -k, 0, -r], ["Z"]];
}

/** The sample's starburst: n points at `ro` and `ri` alternately, first point up. */
export function verifiedBurst(ro: number, ri: number): PathCmd[] {
  return polygonPath(
    Array.from({ length: BADGE_POINTS * 2 }, (_, i) => {
      const a = (Math.PI * i) / BADGE_POINTS - Math.PI / 2;
      const r = i % 2 ? ri : ro;
      return [Math.cos(a) * r, Math.sin(a) * r] as const;
    }),
  );
}

/** Frames of a list of `[at, value, ease?]`, dropping any frame that is not after the one before. */
function seq(list: readonly (readonly [number, number, Ease?])[]): Frames {
  const out: (readonly [number, number, Ease?])[] = [];
  for (const frame of list) if (out.length === 0 || frame[0] > out[out.length - 1]![0]) out.push(frame);
  return out;
}

const offsetFrames = (frames: Frames, by: number): Frames => frames.map((frame) => (frame[2] === undefined ? [frame[0], frame[1] + by] : [frame[0], frame[1] + by, frame[2]])) as unknown as Frames;

/** Rows for words that fit `limit`: one row at a scale of at least `floor`, else even rows; a lone wide word shrinks. Sizes in sample px. */
export function verifiedRows(widthsAt: (size: number) => number[], size0: number, gapEm: number, limit: number, floor: number): { rows: number[][]; size: number; widths: number[] } {
  let size = size0;
  let widths = widthsAt(size);
  const all = widths.map((_, at) => at);
  const gapOf = () => gapEm * size;
  const one = fitScale(rowWidth(widths, all, gapOf()), limit);
  if (one >= floor || widths.length === 1) {
    for (let pass = 0; pass < 3 && rowWidth(widths, all, gapOf()) > limit; pass++) {
      size *= fitScale(rowWidth(widths, all, gapOf()), limit) * 0.995;
      widths = widthsAt(size);
    }
    return { rows: [all], size, widths };
  }
  let rows = balancedRows(widths, gapOf(), limit);
  for (let pass = 0; pass < 4; pass++) {
    const worst = Math.max(...rows.map((row) => rowWidth(widths, row, gapOf())));
    if (worst <= limit) break;
    size *= fitScale(worst, limit) * 0.995;
    widths = widthsAt(size);
    rows = balancedRows(widths, gapOf(), limit);
  }
  return { rows, size, widths };
}

interface Counters {
  hero: number;
  plain: number;
}

interface Sweep {
  readonly L: number;
  readonly R: number;
  readonly from: number;
  readonly to: number;
}

function buildCue(cue: SceneCue, cueNumber: number, input: SceneInput, counters: Counters): Piece[] {
  const space = sceneSpace(input, ANCHOR_Y);
  const { u } = space;
  const X = space.x;
  const rtl = cueDirection(cue) === "rtl";
  const m = rtl ? -1 : 1;
  const band = cueNumber * 20;
  const lang = cue.language;
  const { primary, shadow } = input.colours;
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const hero = heroAt >= 0 ? cue.words[heroAt]! : null;
  const safeW = (space.safe.x2 - space.safe.x1) / u;
  const jitter = verifiedHash(cue) - 0.5;
  const sparkR = (r: number) => r * SPRING_PEAK;

  /** A sample-px advance of `text` in `face` at `size`, without the trailing letter spacing. */
  const advance = (text: string, face: typeof INK_FACE | typeof LEAD_FACE, size: number) => input.measure(text, face, size * u, LS).advance / u;
  /** A word's box in the sample: advance, trailing letter spacing and `PAD` each side. */
  const boxOf = (text: string, face: typeof INK_FACE | typeof LEAD_FACE, size: number) => advance(text, face, size) + LS * size + 2 * PAD * size;

  // --- plan: every item knows its canvas extent; pieces are made once the exit's sweep bounds are known ---
  type Make = (sw: Sweep) => Piece[];
  const items: { x1: number; x2: number; make: Make }[] = [];
  const plan = (x1: number, x2: number, make: Make) => items.push({ x1, x2, make });
  const BIG = space.canvas.width * 3;
  const H = space.canvas.height;
  let ready = cue.startMs;

  /** The wipe edge of a word: its box uncovered from one end (outExpo), as frames. */
  const edgeOf = (start: number, dur: number, left: number, right: number): Frames =>
    rtl ? seq([[start, right], [start + dur, left, "outExpo"]]) : seq([[start, left], [start + dur, right, "outExpo"]]);
  /** The clip of a piece: the wipe edge (or none) and the block's exit running from one end of the content to the other. */
  const exitClip = (sw: Sweep, from: number, y1: number, y2: number, edge?: Frames): Clip => {
    const first = edge ? edge[0]![1] : rtl ? -BIG : BIG;
    const wipe: Frames = edge ? seq([[from, first], ...edge]) : [[from, rtl ? -BIG : BIG]];
    if (!rtl) return { x1: seq([[from, sw.L], [sw.from, sw.L], [sw.to, sw.R, "in"]]), x2: wipe, y1: [[from, y1]], y2: [[from, y2]] };
    return { x1: wipe, x2: seq([[from, sw.R], [sw.from, sw.R], [sw.to, sw.L, "in"]]), y1: [[from, y1]], y2: [[from, y2]] };
  };
  /** When the exit's edge has passed a piece spanning canvas `[left, right]`: its clip would invert, so it ends then. */
  const leaveAt = (sw: Sweep, left: number, right: number) => {
    const share = rtl ? (sw.R - left) / (sw.R - sw.L) : (right - sw.L) / (sw.R - sw.L);
    return share >= 1 ? sw.to : sw.from + Math.cbrt(Math.max(0, share)) * (sw.to - sw.from);
  };
  const shadowOf = (size: number) => [{ dx: 0, dy: 0.06 * size * u, blur: 0.06 * size * u, colour: shadow, alpha: SHADOW_ALPHA }];

  const cursorPiece = (id: string, z: number, left: number, right: number, top: number, size: number, from: number, dur: number, colour: string, to: number, window?: { y1: number; y2: number }): Piece => {
    const px = size * u;
    const cw = 0.36 * px;
    const ch = 0.8 * px;
    const travel = right - left - 0.4 * cw;
    const fadeAt = from + dur * 0.55;
    const fadeEnd = fadeAt + 160;
    const piece: ShapePiece = {
      id: `verified:${cueNumber}:${id}`,
      kind: "shape",
      z: band + z,
      fromMs: from,
      toMs: Math.min(to, fadeEnd - 8),
      track: {
        x: rtl ? [[from, right], [from + dur, right - travel, "outExpo"]] : [[from, left], [from + dur, left + travel, "outExpo"]],
        y: [[from, top + 0.02 * px + ch / 2]],
        sx: [[fadeAt, 1], [fadeEnd, 0, "out"]],
      },
      clip: { x1: [[from, space.safe.x1]], x2: [[from, space.safe.x2]], y1: [[from, window?.y1 ?? 0]], y2: [[from, window?.y2 ?? H]] },
      origin: { dx: rtl ? cw : 0, dy: ch / 2 },
      path: rectPath(0, 0, cw, ch),
      fill: { colour },
    };
    return piece;
  };

  type Face = typeof INK_FACE | typeof LEAD_FACE;
  interface Fit {
    readonly list: readonly number[];
    readonly face: Face;
    readonly texts: string[];
    readonly rows: number[][];
    readonly size: number;
    readonly widths: number[];
    readonly gap: number;
    readonly rowGap: number;
    readonly height: number;
  }
  const fitWords = (list: readonly number[], face: Face, size0: number, gap0: number, rowGap: number): Fit => {
    const texts = list.map((at) => verifiedCase(cue.words[at]!.text));
    const fit = verifiedRows((size) => texts.map((text) => boxOf(text, face, size)), size0, gap0 / size0, Math.min(ROW_LIMIT, safeW), ROW_FLOOR);
    const lh = LINE_H * fit.size;
    return { list, face, texts, rows: fit.rows, size: fit.size, widths: fit.widths, gap: (gap0 / size0) * fit.size, rowGap, height: fit.rows.length * lh + (fit.rows.length - 1) * rowGap };
  };
  /** Sets a fitted block of words with its top at sample y `top`; returns where each word's box went (canvas px). */
  const placeWords = (fit: Fit, top: number, z: number, tag: string) => {
    const { size, face } = fit;
    const px = size * u;
    const lh = LINE_H * size;
    const where = new Map<number, { left: number; right: number; top: number }>();
    fit.rows.forEach((row, ri) => {
      const order = rowVisualOrder(row.map((at) => fit.texts[at]!), rtl ? "rtl" : "ltr").map((at) => row[at]!);
      const width = order.reduce((sum, at) => sum + fit.widths[at]!, 0) + fit.gap * (order.length - 1);
      let x = CX - width / 2;
      const rowTop = top + ri * (lh + fit.rowGap);
      const boxTop = space.y(rowTop);
      const baseline = space.y(rowTop + verifiedBaseline(size, LINE_H));
      for (const at of order) {
        const index = fit.list[at]!;
        const word = cue.words[index]!;
        const left = X(x);
        const right = left + fit.widths[at]! * u;
        where.set(index, { left, right, top: boxTop });
        const from = word.startMs - 70;
        ready = Math.max(ready, from + WRAP_MS * P99_EXPO);
        plan(left, right, (sw) => [
          {
            id: `verified:${cueNumber}:${tag}${index}`,
            kind: "text",
            z: band + z,
            fromMs: from + 4,
            toMs: leaveAt(sw, left, right),
            track: { x: [[from, left + PAD * px]], y: [[from, baseline]] },
            clip: exitClip(sw, from, baseline - 1.15 * px, baseline + 0.55 * px, edgeOf(from, WRAP_MS, left, right)),
            text: fit.texts[at]!,
            face,
            sizePx: px,
            letterSpacingEm: LS,
            fill: primary,
            shadows: shadowOf(size),
            anchor: "baseline-left",
            language: lang,
          },
          cursorPiece(`${tag}${index}c`, z, left, right, boxTop, size, from, WRAP_MS, primary, sw.to),
        ]);
        x += fit.widths[at]! + fit.gap;
      }
    });
    return where;
  };

  /** A starburst check badge popping at canvas (cx, cy), `b` sample px across, clamped inside the safe area. */
  const addBadge = (id: string, cxWanted: number, cy: number, b: number, colour: string, t0: number, z: number) => {
    const k = (b * u) / 120;
    const burst = anchored(verifiedBurst(58 * k, 46 * k));
    // Its box turns from -40 degrees while it springs past full size: keep the box's whole circle inside.
    const reach = (Math.hypot(burst.w, burst.h) / 2) * SPRING_PEAK;
    const cx = Math.min(space.safe.x2 - reach, Math.max(space.safe.x1 + reach, cxWanted));
    const tick = anchored(polylinePath([[-22 * k, 2 * k], [-6 * k, 18 * k], [24 * k, -16 * k]]));
    plan(cx - reach, cx + reach, (sw) => {
      const from = t0 + 8;
      const track = { x: [[from, cx]], y: [[from, cy]], sx: [[t0, 0], [t0 + 420, 1, "spring"]], sy: [[t0, 0], [t0 + 420, 1, "spring"]], rz: [[t0, -40], [t0 + 420, 0, "spring"]] } as const;
      const clip = exitClip(sw, from, 0, H);
      return [
        { id: `verified:${cueNumber}:${id}`, kind: "shape", z: band + z, fromMs: from, toMs: sw.to, track, clip, origin: burst.origin, path: burst.path, fill: { colour } },
        { id: `verified:${cueNumber}:${id}k`, kind: "shape", z: band + z, fromMs: from, toMs: sw.to, track, clip, origin: tick.origin, path: tick.path, stroke: { widthPx: 13 * k, colour: inkOn(colour) } },
      ];
    });
  };
  /** A sparkle springing in at canvas (cx, cy) and twinkling while the cue is held. */
  const addSpark = (id: string, cxWanted: number, cy: number, r: number, t0: number, z: number) => {
    const rr = r * u;
    const reach = Math.SQRT2 * sparkR(rr);
    const cx = Math.min(space.safe.x2 - reach, Math.max(space.safe.x1 + reach, cxWanted));
    const shape = anchored(verifiedSparkle(rr));
    plan(cx - reach, cx + reach, (sw) => {
      const from = t0 + 8;
      const twinkle: [number, number, Ease?][] = [[t0 + 380, 1, "spring"]];
      for (let t = t0 + 380 + 550, low = true; t < sw.from && twinkle.length < 24; t += 550, low = !low) twinkle.push([t, low ? 0.86 : 1, "inOut"]);
      const scale: Frames = seq([[t0, 0], [t0 + 380, 1, "spring"], ...twinkle.slice(1)]);
      return [
        {
          id: `verified:${cueNumber}:${id}`,
          kind: "shape",
          z: band + z,
          fromMs: from,
          toMs: sw.to,
          track: { x: [[from, cx]], y: [[from, cy]], sx: scale, sy: scale, rz: [[t0, 90], [t0 + 380, 0, "spring"]] },
          clip: exitClip(sw, from, 0, H),
          origin: shape.origin,
          path: shape.path,
          fill: { colour: input.colours.highlight },
        },
      ];
    });
  };

  const jitterDeg = jitter * 2;
  if (!hero) {
    // --- no hero: the plain rows, a small check badge on the cue's last (or first) word and a sparkle at the other end ---
    const n = counters.plain++;
    const pal = verifiedPalette(input.colours, n + 1);
    const fit = fitWords(cue.words.map((_, at) => at), INK_FACE, PLAIN_SIZE, PLAIN_GAP, PLAIN_ROW_GAP);
    const where = placeWords(fit, ANCHOR_Y - fit.height / 2, 3, "w");
    const side = (n % 2 === 0 ? 1 : -1) * m;
    const target = n % 2 === 0 ? cue.words.length - 1 : 0;
    const other = n % 2 === 0 ? 0 : cue.words.length - 1;
    const box = where.get(target)!;
    const b = 0.6 * PLAIN_SIZE;
    addBadge("badge", (side > 0 ? box.right : box.left) - side * 0.05 * b * u, box.top + 0.05 * b * u, b, pal.badge, cue.words[target]!.startMs + 200, 6);
    const far = where.get(other)!;
    addSpark("spark", (side > 0 ? far.left : far.right) + side * 0.4 * PLAIN_SIZE * u * 0.35, far.top + 0.3 * LINE_H * fit.size * u, 20, cue.words[other]!.startMs + 290, 6);
  } else {
    // --- hero: lead rows, three stacked hero rows, the pill, the badge and the sparkles ---
    const n = counters.hero++;
    const pal = verifiedPalette(input.colours, n);
    const pillInk = inkOn(pal.pill);
    const variant = n % 2;
    const hs = hero.startMs;
    const heroText = verifiedCase(hero.text);
    const boxWAt = (size: number) => advance(heroText, INK_FACE, size) + LS * size + 2 * PAD * size;
    const probe = advance(heroText, INK_FACE, HERO_MAX) + LS * HERO_MAX;
    let size = Math.min(HERO_MAX, (HERO_MAX * HERO_FIT) / probe);
    while (boxWAt(size) > safeW) size *= 0.98;
    const L = LINE_H * size;
    const boxW = boxWAt(size);
    const px = size * u;

    const leadList = cue.words.slice(0, heroAt).map((_, at) => at);
    const trailList = cue.words.slice(heroAt + 1).map((_, at) => heroAt + 1 + at);
    const lead = leadList.length > 0 ? fitWords(leadList, LEAD_FACE, LEAD_SIZE, LEAD_GAP, LEAD_ROW_GAP) : null;

    // The pill: chrome 158 px plus the trailing words in one line, or two when they would not fit; the star and the check alone without words.
    const trailTexts = trailList.map((at) => verifiedCase(cue.words[at]!.text));
    const pillFit = trailList.length > 0 ? verifiedRows((s) => trailTexts.map((text) => advance(text, INK_FACE, s) + LS * s), PILL_SIZE, PILL_GAP_EM, Math.min(PILL_MAX, safeW) - PILL_CHROME, PILL_FLOOR) : null;
    const pillGap = pillFit ? PILL_GAP_EM * pillFit.size : 0;
    const lineWidths = pillFit ? pillFit.rows.map((row) => rowWidth(pillFit.widths, row, pillGap)) : [];
    const textW = lineWidths.length > 0 ? Math.max(...lineWidths) : 0;
    const textH = pillFit ? pillFit.rows.length * pillFit.size : 0;
    const pillW = PILL_CHROME + textW;
    const pillH = 32 + Math.max(40, textH);

    const leadBlock = lead ? lead.height + LEAD_MARGIN : 0;
    const stackTop = ANCHOR_Y - (leadBlock + 2.04 * L - 0.3 * L + pillH) / 2 + leadBlock;
    if (lead) placeWords(lead, stackTop - leadBlock, 3, "l");

    // --- the hero's three rows ---
    const left = X(CX) - (boxW * u) / 2;
    const right = left + boxW * u;
    const baseOff = verifiedBaseline(size, LINE_H);
    for (const k of [-1, 0, 1] as const) {
      const boxTop = stackTop + (k < 0 ? -0.48 * L : k === 0 ? 0.52 * L : 1.52 * L);
      const start = hs + (k === 0 ? 0 : (k + 1) * 50 - 50);
      const from = start - 70;
      const baseline = space.y(boxTop + baseOff);
      const winTop = k < 0 ? stackTop : stackTop + 1.52 * L;
      const win = k === 0 ? { y1: baseline - 1.15 * px, y2: baseline + 0.55 * px } : { y1: space.y(winTop), y2: space.y(winTop + 0.52 * L) };
      if (k === 0) ready = Math.max(ready, from + HERO_WRAP_MS * P99_EXPO);
      const edge = edgeOf(from, HERO_WRAP_MS, left, right);
      const id = `h${k + 1}`;
      plan(left, right, (sw) => {
        const clip = exitClip(sw, from, win.y1, win.y2, edge);
        const to = leaveAt(sw, left, right);
        const cursor = cursorPiece(`${id}c`, k === 0 ? 2 : 1, left, right, space.y(boxTop), size, from, HERO_WRAP_MS, k === 0 ? pal.pill : primary, sw.to, k === 0 ? undefined : win);
        if (k === 0) {
          const text: TextPiece = {
            id: `verified:${cueNumber}:${id}`,
            kind: "text",
            z: band + 2,
            fromMs: from + 4,
            toMs: to,
            track: { x: [[from, left + PAD * px]], y: [[from, baseline]] },
            clip,
            text: heroText,
            face: INK_FACE,
            sizePx: px,
            letterSpacingEm: LS,
            fill: primary,
            shadows: shadowOf(size),
            anchor: "baseline-left",
            language: lang,
          };
          return [text, cursor];
        }
        // An echo shows the half of the word nearest the hero. It hollows out: the fill fades while a 0.7-alpha outline stays,
        // and the whole echo shrinks toward the hero and dims to half.
        const edgeY = space.y(k < 0 ? stackTop + 0.52 * L : stackTop + 1.52 * L);
        const c0 = hs + 520;
        const c1 = hs + 940;
        const track = {
          x: [[from, X(CX)]],
          y: [[from, edgeY]],
          sx: [[c0, 1], [c1, 0.94, "outExpo"]],
          sy: [[c0, 1], [c1, 0.94, "outExpo"]],
        } as const;
        const common = {
          kind: "text",
          z: band + 1,
          fromMs: from + 4,
          clip,
          origin: { dx: X(CX) - (left + PAD * px), dy: edgeY - baseline },
          text: heroText,
          face: INK_FACE,
          sizePx: px,
          letterSpacingEm: LS,
          anchor: "baseline-left",
          language: lang,
        } as const;
        const hollow = (t: number) => {
          const c = EASES.outExpo(prog(t, c0, c1 - c0));
          return (1 - c) * (1 - 0.5 * c);
        };
        const fill: TextPiece = { ...common, id: `verified:${cueNumber}:${id}f`, toMs: Math.min(to, c1), track: { ...track, o: sampleFrames(hollow, [c0, c1], 0.01) }, fill: primary };
        const ring: TextPiece = {
          ...common,
          id: `verified:${cueNumber}:${id}r`,
          toMs: to,
          track: { ...track, o: [[c0, 1], [c1, 0.5, "outExpo"]] },
          fill: primary,
          fillAlpha: 0,
          stroke: { widthPx: RING_EM * px, colour: primary, alpha: PRIMARY_ALPHA },
        };
        return [fill, ring, cursor];
      });
    }

    // --- badge and sparkles: the badge on one top corner of the hero, the sparkles twinkling on the other side ---
    const side = (variant === 0 ? 1 : -1) * m;
    const b = Math.round(0.62 * size);
    addBadge("badge", X(CX) + side * ((boxW * u) / 2 - 0.05 * b * u), space.y(stackTop + 0.52 * L + 0.05 * b), b, pal.badge, hs + 260, 6);
    addSpark("sparkA", X(CX) - side * ((boxW / 2 + 40) * u), space.y(stackTop + 0.74 * L), 34, hs + 360, 6);
    addSpark("sparkB", X(CX) - side * ((boxW / 2 + 4) * u), space.y(stackTop + 1.34 * L), 20, hs + 450, 6);

    // --- the pill: tilted, shooting in along its tilt, typing the trailing words ---
    const firstTrail = trailList.length > 0 ? cue.words[trailList[0]!]!.startMs : hs + 440;
    const lastTrail = trailList.length > 0 ? cue.words[trailList[trailList.length - 1]!]!.startMs : hs + 140;
    const inAt = Math.max(hs + 160, firstTrail - 280);
    const shoot = (variant === 0 ? 1 : -1) * m;
    const angDeg = -shoot * (variant === 0 ? 7 : 5) + jitterDeg;
    const ang = (angDeg * Math.PI) / 180;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const cx0 = X(CX);
    const cy0 = space.y(stackTop + 2.04 * L - 0.3 * L + pillH / 2);
    const away = (t: number) => shoot * 900 * u * (1 - outBack14(prog(t, inAt, 300)));
    const posX = sampleFrames((t) => cx0 + cos * away(t), [inAt, inAt + 300], 0.25);
    const posY = sampleFrames((t) => cy0 + sin * away(t), [inAt, inAt + 300], 0.25);
    const pw = pillW * u;
    const ph = pillH * u;
    const restHalf = (pw / 2) * Math.abs(cos) + (ph / 2) * Math.abs(sin);
    const local = (lx: number, ly: number) => ({ x: lx * cos - ly * sin, y: lx * sin + ly * cos });
    const textLeft = m > 0 ? -pillW / 2 + 72 : pillW / 2 - 72 - textW;
    const checkLx = m * (pillW / 2 - 50) * u;
    const starLx = m * (-pillW / 2 + 41) * u;
    for (const word of trailList) ready = Math.max(ready, cue.words[word]!.startMs - 60 + 120 * P99_OUT);

    plan(cx0 - restHalf, cx0 + restHalf, (sw) => {
      const out: Piece[] = [];
      const from = inAt;
      const group = { x: posX, y: posY, rz: [[from, angDeg]] } as const;
      const clip = exitClip(sw, from, 0, H);
      const body = anchored(roundedRectPath(0, 0, pw, ph, ph / 2));
      out.push({
        id: `verified:${cueNumber}:pill`,
        kind: "shape",
        z: band + 4,
        fromMs: from,
        toMs: sw.to,
        bleed: true,
        track: group,
        clip,
        origin: { dx: pw / 2, dy: ph / 2 },
        path: body.path,
        fill: { colour: pal.pill },
        shadows: [{ dx: 0, dy: 0.1 * ph, blur: 0.12 * ph, colour: shadow, alpha: 0.5 }],
      });
      const star = anchored(verifiedSparkle(14 * u));
      out.push({
        id: `verified:${cueNumber}:pillstar`,
        kind: "shape",
        z: band + 5,
        fromMs: from,
        toMs: sw.to,
        bleed: true,
        track: group,
        clip,
        origin: { dx: -(starLx - star.w / 2), dy: star.h / 2 },
        path: star.path,
        fill: { colour: pillInk },
      });
      // The words, each typed on inside the moving, tilted pill: its clip edge is the word's own edge carried through the pill's pose.
      if (pillFit) {
        const psize = pillFit.size;
        const lineBase = verifiedBaseline(psize, 1);
        pillFit.rows.forEach((row, ri) => {
          const order = rowVisualOrder(row.map((at) => trailTexts[at]!), rtl ? "rtl" : "ltr").map((at) => row[at]!);
          let x = textLeft + (textW - lineWidths[ri]!) / 2;
          const lineTop = -textH / 2 + ri * psize;
          const ly = (lineTop + lineBase) * u;
          const lyc = (lineTop + psize / 2) * u;
          for (const at of order) {
            const word = cue.words[trailList[at]!]!;
            const wl = x * u;
            const ww = pillFit.widths[at]! * u;
            x += pillFit.widths[at]! + pillGap;
            const q = (t: number) => EASES.out(prog(t, word.startMs - 60, 120));
            const edgeAt = (t: number) => {
              const along = rtl ? wl + ww * (1 - q(t)) : wl + ww * q(t);
              const x = cx0 + cos * away(t) + along * cos - lyc * sin;
              // Off to the side the pill is not yet over the content: the clip stays an empty rectangle, never an inverted one.
              return rtl ? Math.min(x, sw.R) : Math.max(x, sw.L);
            };
            const edges = [from, word.startMs - 60, word.startMs + 60, inAt + 300].filter((t) => t >= from).sort((a, b) => a - b);
            const wipe = sampleFrames(edgeAt, edges, 0.25);
            const right = cx0 + (wl + ww) * cos - lyc * sin;
            const leftEdge = cx0 + wl * cos - lyc * sin;
            out.push({
              id: `verified:${cueNumber}:pw${trailList[at]!}`,
              kind: "text",
              z: band + 5,
              fromMs: from,
              toMs: leaveAt(sw, leftEdge, right),
              bleed: true,
              track: group,
              clip: exitClip(sw, from, 0, H, wipe),
              origin: { dx: -wl, dy: -ly },
              text: verifiedCase(word.text),
              face: INK_FACE,
              sizePx: psize * u,
              letterSpacingEm: LS,
              fill: pillInk,
              anchor: "baseline-left",
              language: lang,
            });
          }
        });
      }
      // The check pops last, about its own centre.
      const c0 = trailList.length > 0 ? lastTrail + 120 : inAt + 260;
      const cc = local(checkLx, 0);
      const checkTrack = { x: offsetFrames(posX, cc.x), y: offsetFrames(posY, cc.y), sx: [[c0, 0], [c0 + 360, 1, "spring"]], sy: [[c0, 0], [c0 + 360, 1, "spring"]], rz: [[c0, angDeg]] } as const;
      const disc = anchored(ellipsePath(0, 0, 19 * u));
      const tick = anchored(polylinePath([[-8 * u, 0], [-2 * u, 7 * u], [9 * u, -6 * u]]));
      const cFrom = Math.max(from, c0 + 8);
      out.push(
        { id: `verified:${cueNumber}:pillcheck`, kind: "shape", z: band + 5, fromMs: cFrom, toMs: sw.to, bleed: true, track: checkTrack, clip, origin: disc.origin, path: disc.path, fill: { colour: pillInk } },
        { id: `verified:${cueNumber}:pillcheckk`, kind: "shape", z: band + 5, fromMs: cFrom, toMs: sw.to, bleed: true, track: checkTrack, clip, origin: tick.origin, path: tick.path, stroke: { widthPx: 5 * u, colour: pal.pill } },
      );
      return out;
    });
  }

  // --- the sweep: the content's own extent, and an exit that waits until every word has been readable ---
  const exit = verifiedExit(cue, ready);
  const sweep: Sweep = {
    L: Math.min(...items.map((item) => item.x1)) - 24 * u,
    R: Math.max(...items.map((item) => item.x2)) + 24 * u,
    from: exit.from,
    to: exit.to,
  };
  return clampToSafeArea(items.flatMap((item) => item.make(sweep)), space.safe, input.measure);
}

export const verifiedProgram: SceneProgram = {
  build(input) {
    const counters: Counters = { hero: 0, plain: 0 };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, input, counters))) };
  },
};
