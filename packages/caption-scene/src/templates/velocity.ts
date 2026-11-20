import type { DemoScript } from "../demo";
import { type Frames, EASES, kf, prog } from "../ease";
import { speechRate } from "../detect";
import type { SceneInput, SceneProgram, SceneCue } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { Clip, Piece, ShapePiece, TextPiece } from "../scene";
import { centredRect, roundedRectPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Velocity (`samples/templates/54-velocity.js`): condensed caps skid in on a forward lean, and the hero rides a
 * slanted brand-colour slab that slices in from the left. How fast the cue was spoken (`speechRate`: words over
 * spoken time) sets the lean and how many speed lines streak off the slab: a calm cue barely tilts and has no
 * lines, a rant leans hard and streaks.
 *
 * Geometry is the sample's, in its 1080 x 1920 frame: Anton caps at 96 (a no-hero cue 115, the hero 178), a row
 * is its cap height (0.859 em) with 0.26 em between rows, the slab is the hero's cap height plus 0.36 body sizes
 * tall and the hero's width plus half a body size wide, 19.2 px from the rows around it. Rows sit on the anchor
 * line (y 1290). The sample places a word by its cap top, so a baseline is that plus the cap height. Anton's cap
 * height and the 1.18 / 0.33 line box (`capTopEm` 0.064) were read from the face in Chrome.
 *
 * The glow around support words is 0.22 em across, not the sample's 0.3 (render budget, see `GLOW`). Right-to-left cues mirror the whole template (skid, lean, wipe, speed lines), so the motion still travels the
 * way the line is read. The sample's slab clip rotates with the slab's 1.2 degree rock; here the clip stays
 * axis-aligned (its top and bottom margins grow to cover the rock), and the shadow rocks about its own centre,
 * under a quarter of a pixel from the sample's.
 */

export const VELOCITY_DEMO: DemoScript = {
  lines: [
    "nobody's:b@560 coming:b@560 to:m@300 save:b@540 you:h@820",
    "so:m@150 get:b@170 up:b@160 and:m@130 go:h@320",
    "every:b@230 single:b@260 morning:b@340",
    "no:m@120 days:b@160 off:h@340",
  ],
  options: { lead: 380, cueGap: 180 },
};

const ANCHOR_LINE = 1290;
const FACE = "Anton" as const;
const LETTER_SPACING = 0.01;
const BODY = 96;
const HERO = Math.round(BODY * 1.85);
const SOLO = Math.round(BODY * 1.2);
const MAX_W = 900;
/** Anton's cap height and the offset of a cap top below the top of a `line-height: 1` box, em (read in Chrome). */
const CAP = 0.859375;
const EXIT = 130;
const HARD_SHADOW_EM = 0.05;
/**
 * The sample's glow is `0 0 0.3em` (29 px at 96); drawn at 0.22 em (a 10.5 px sigma) because a glow is a big blurred bitmap
 * composited every frame it is on screen, and Velocity's was 0.5x Headline's cost: 1.65x Headline with the sample's, 1.43x with this.
 * Side by side with the sample the halo is not distinguishable.
 */
const GLOW = { em: 0.22, alpha: 0.42 } as const;
const SLAB_SHADOW_ALPHA = 0.45;
const LINE = { colour: "#FFFFFF", alpha: 0.78 } as const;
const FRACS = [0.2, 0.4, 0.6, 0.8] as const;
const LENS = [1.2, 2.0, 1.5, 2.4] as const;
/** The rock of the whole slab on impact, degrees (CSS `rotate`). */
const ROCK_PEAK = 1.2;

const deg = (slope: number) => (Math.atan(slope) * 180) / Math.PI;

/** `sampleFrames` over `[from, to]` with collinear frames dropped: a constant is one frame. */
const sampled = (fn: (t: number) => number, edges: readonly number[], from: number, to: number, tolerance: number): Frames => sampleFrames(fn, edges, tolerance, { range: [from, to], simplify: true });

interface RowItem {
  readonly index: number;
  /** CSS box: advance plus the trailing letter spacing. */
  readonly boxWidth: number;
  readonly left: number;
}

interface Row {
  readonly kind: "row" | "hero";
  readonly size: number;
  /** Cap height of a row, slab height of the hero row. */
  readonly height: number;
  readonly items: readonly RowItem[];
  /** Top of the row's cap (a row) or of the slab (the hero), canvas px. */
  top: number;
}

function buildCue(cue: SceneCue, input: SceneInput, cueNumber: number): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u } = space;
  const direction = cueDirection(cue);
  const m = direction === "rtl" ? -1 : 1;
  const { lean: k, lines: lineCount } = speechRate(cue);
  const safeWidth = space.safe.x2 - space.safe.x1;
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const texts = cue.words.map((word) => word.text.toUpperCase());
  const boxWidth = (index: number, size: number) => input.measure(texts[index]!, FACE, size, LETTER_SPACING).advance + LETTER_SPACING * size;
  const gapOf = (size: number) => size * 0.22 + Math.abs(k) * CAP * size * 0.6;
  const skid = 0.6 * BODY * u;
  /** The widest a row may be: the sample's 900, and what leaves the safe area room for the lean and the skid. */
  const maxRow = (size: number) => Math.min(MAX_W * u, safeWidth - skid - Math.abs(k) * CAP * size);

  const supportIndices = cue.words.map((_, index) => index).filter((index) => index !== heroAt);
  const nominal = (heroAt < 0 ? SOLO : BODY) * u;
  let size = nominal;
  for (let pass = 0; pass < 3 && supportIndices.length > 0; pass++) {
    const widest = Math.max(...supportIndices.map((index) => boxWidth(index, size)));
    const fit = fitScale(widest, maxRow(size));
    if (fit >= 0.999) break;
    size *= fit;
  }

  /** The sample's rows: one, or two balanced ones (a break before a minor word wins ties); more only when two would not fit. */
  const rowsOf = (indices: readonly number[]): number[][] => {
    if (indices.length === 0) return [];
    const widths = indices.map((index) => boxWidth(index, size));
    const gap = gapOf(size);
    const limit = maxRow(size);
    const all = widths.map((_, at) => at);
    if (indices.length === 1 || rowWidth(widths, all, gap) <= limit) return [[...indices]];
    const cost = (at: number) =>
      Math.max(rowWidth(widths, all.slice(0, at), gap), rowWidth(widths, all.slice(at), gap)) - (cue.words[indices[at]!]!.role === "minor" ? 0.9 * size : 0);
    let best = 1;
    for (let at = 1; at < indices.length; at++) if (cost(at) < cost(best)) best = at;
    const two = [all.slice(0, best), all.slice(best)];
    if (two.every((row) => row.length === 1 || rowWidth(widths, row, gap) <= limit)) return two.map((row) => row.map((at) => indices[at]!));
    return balancedRows(widths, gap, limit).map((row) => row.map((at) => indices[at]!));
  };

  const slabGeometry = (heroSize: number) => {
    const cap = CAP * heroSize;
    const heroBox = boxWidth(heroAt, heroSize);
    const slabH = cap + 0.36 * BODY * u;
    const slabW = heroBox + 0.5 * BODY * u;
    const pad = 0.17 * slabH;
    const off = 0.12 * BODY * u;
    return { cap, heroBox, slabH, slabW, pad, off, extent: slabW + 2 * pad + off };
  };
  let heroSize = HERO * u;
  if (heroAt >= 0 && slabGeometry(heroSize).extent > safeWidth) {
    let low = 0;
    let high = heroSize;
    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2;
      if (slabGeometry(mid).extent > safeWidth) high = mid;
      else low = mid;
    }
    heroSize = low;
  }
  const hero = heroAt >= 0 ? slabGeometry(heroSize) : null;

  // Stack: rows before the hero, the slab, rows after it.
  const centreX = space.x(540);
  const rowGap = 0.26 * size;
  const heroGap = 0.2 * BODY * u;
  const toRow = (indices: readonly number[]): Row => {
    const gap = gapOf(size);
    const widths = indices.map((index) => boxWidth(index, size));
    const order = rowVisualOrder(indices.map((index) => texts[index]!), direction);
    const width = rowWidth(widths, order, gap);
    let x = centreX - width / 2;
    const items = order.map((at) => {
      const item = { index: indices[at]!, boxWidth: widths[at]!, left: x };
      x += widths[at]! + gap;
      return item;
    });
    return { kind: "row", size, height: CAP * size, items, top: 0 };
  };
  const before = heroAt < 0 ? supportIndices : supportIndices.filter((index) => index < heroAt);
  const after = heroAt < 0 ? [] : supportIndices.filter((index) => index > heroAt);
  const rows: Row[] = [
    ...rowsOf(before).map(toRow),
    ...(hero ? [{ kind: "hero" as const, size: heroSize, height: hero.slabH, items: [] as RowItem[], top: 0 }] : []),
    ...rowsOf(after).map(toRow),
  ];
  const gapBetween = (at: number) => (rows[at]!.kind === "hero" || rows[at - 1]!.kind === "hero" ? heroGap : rowGap);
  let total = rows.reduce((sum, row) => sum + row.height, 0);
  for (let at = 1; at < rows.length; at++) total += gapBetween(at);
  let cursor = space.y(ANCHOR_LINE) - total / 2;
  rows.forEach((row, at) => {
    if (at > 0) cursor += gapBetween(at);
    row.top = cursor;
    cursor += row.height;
  });

  const end = cue.endMs;
  const fadeFrom = end - EXIT - 20;
  const fadeTo = end - 50;
  const fade = (t: number) => 1 - EASES.in(prog(t, fadeFrom, fadeTo - fadeFrom));
  const pieces: Piece[] = [];
  const zBase = cueNumber * 32;
  const zOf = (rowAt: number, sub: number) => zBase + Math.min(28, 2 + rowAt * 4) + sub;
  const glow = Math.round(GLOW.em * size) / 2;
  let longest: { left: number; boxWidth: number; top: number; cap: number; startMs: number } | null = null;

  rows.forEach((row, rowAt) => {
    if (row.kind !== "row") return;
    for (const item of row.items) {
      const word = cue.words[item.index]!;
      const t0 = word.startMs - 50;
      const fromMs = t0;
      const toMs = fadeTo;
      if (!longest || item.boxWidth > longest.boxWidth) longest = { left: item.left, boxWidth: item.boxWidth, top: row.top, cap: row.height, startMs: word.startMs };
      if (toMs <= fromMs) continue;
      const pivotX = item.left + item.boxWidth / 2;
      const pivotY = row.top + row.height / 2;
      const rise = (t: number) => prog(t, t0, 45) * fade(t);
      pieces.push({
        id: `velocity:${cueNumber}:w${item.index}`,
        kind: "text",
        z: zOf(rowAt, 0),
        fromMs,
        toMs,
        track: {
          x: [[t0, pivotX - m * skid], [t0 + 150, pivotX, "out"]],
          y: [[t0, pivotY]],
          skx: sampled((t) => m * deg(k - 0.25 * (1 - EASES.out(prog(t, t0, 200)))), [t0, t0 + 200], fromMs, toMs, 0.05),
          o: t0 + 45 <= fadeFrom ? [[t0, 0], [t0 + 45, 1], [fadeFrom, 1], [fadeTo, 0, "in"]] : sampled(rise, [t0, t0 + 45, fadeFrom, fadeTo], fromMs, toMs, 0.01),
        },
        origin: { dx: item.boxWidth / 2, dy: -row.height / 2 },
        text: texts[item.index]!,
        face: FACE,
        sizePx: row.size,
        letterSpacingEm: LETTER_SPACING,
        fill: input.colours.primary,
        shadows: [
          { dx: HARD_SHADOW_EM * row.size, dy: HARD_SHADOW_EM * row.size, blur: 0, colour: input.colours.shadow, alpha: 1 },
          { dx: 0, dy: 0, blur: glow, colour: input.colours.shadow, alpha: GLOW.alpha },
        ],
        anchor: "baseline-left",
        language: cue.language,
      } satisfies TextPiece);
    }
  });

  // The slab: plate and its shadow behind, the hero's letters on it, all one group (one rock, one clip).
  let anchor: { lead: number; top: number; height: number; startMs: number } | null = null;
  const heroRowAt = rows.findIndex((row) => row.kind === "hero");
  if (hero && heroRowAt >= 0) {
    const word = cue.words[heroAt]!;
    const ws = word.startMs;
    const row = rows[heroRowAt]!;
    const cy = row.top + hero.slabH / 2;
    const slabFrom = ws - 80;
    const slabTo = end - 10;
    anchor = { lead: m > 0 ? centreX - hero.slabW / 2 : centreX + hero.slabW / 2, top: row.top, height: hero.slabH, startMs: ws };
    if (slabTo > slabFrom) {
      const rockMargin = Math.sin((ROCK_PEAK * Math.PI) / 180) * (hero.slabW / 2 + hero.pad + hero.off);
      const clipLeft = m > 0 ? centreX - hero.slabW / 2 - hero.pad : centreX - hero.slabW / 2 - hero.pad - hero.off;
      const clipRight = m > 0 ? centreX + hero.slabW / 2 + hero.pad + hero.off : centreX + hero.slabW / 2 + hero.pad;
      const clipWidth = clipRight - clipLeft;
      const wipeFrom = ws - 80;
      const wipeTo = ws + 40;
      const goneFrom = end - EXIT;
      const goneTo = end - 10;
      const enter = (t: number) => clipWidth * (1 - prog(t, wipeFrom, 120));
      const exit = (t: number) => clipWidth * EASES.in(prog(t, goneFrom, EXIT - 10));
      const enterFrames = (base: number, sign: 1 | -1): Frames => [[slabFrom, base + sign * clipWidth], [wipeFrom, base + sign * clipWidth], [wipeTo, base]];
      const exitFrames = (base: number, sign: 1 | -1): Frames => [[slabFrom, base], [goneFrom, base], [goneTo, base + sign * clipWidth, "in"]];
      const edges = [wipeFrom, wipeTo, goneFrom, goneTo];
      const overlap = wipeTo > goneFrom;
      // The wipe and the exit are one edge each; they only meet when the hero starts within 170 ms of the cue's end.
      const x1: Frames = m > 0 ? exitFrames(clipLeft, 1) : overlap ? sampled((t) => Math.min(clipRight - exit(t), clipLeft + enter(t)), edges, slabFrom, slabTo, 0.3) : enterFrames(clipLeft, 1);
      const x2: Frames = m > 0 ? (overlap ? sampled((t) => Math.max(clipLeft + exit(t), clipRight - enter(t)), edges, slabFrom, slabTo, 0.3) : enterFrames(clipRight, -1)) : exitFrames(clipRight, -1);
      const clip: Clip = {
        x1,
        x2,
        y1: [[slabFrom, row.top - 4 - rockMargin]],
        y2: [[slabFrom, row.top + hero.slabH + hero.off + 4 + rockMargin]],
      };
      const lean = (t: number) => m * deg(kf(t, [[ws + 30, k - 0.08], [ws + 150, k, "out"]]));
      const skx = sampled(lean, [ws + 30, ws + 150], slabFrom, slabTo, 0.05);
      const rz: Frames = [[ws + 80, 0], [ws + 120, ROCK_PEAK, "out"], [ws + 165, -0.8, "inOut"], [ws + 210, 0, "inOut"]];
      const base = zOf(heroRowAt, 0);
      pieces.push({
        id: `velocity:${cueNumber}:slabshadow`,
        kind: "shape",
        z: base,
        fromMs: slabFrom,
        toMs: slabTo,
        track: { x: [[slabFrom, centreX + m * hero.off]], y: [[slabFrom, cy + hero.off]], skx, rz },
        clip,
        path: centredRect(hero.slabW, hero.slabH),
        fill: { colour: input.colours.shadow, alpha: SLAB_SHADOW_ALPHA },
      } satisfies ShapePiece);
      pieces.push({
        id: `velocity:${cueNumber}:slab`,
        kind: "shape",
        z: base + 1,
        fromMs: slabFrom,
        toMs: slabTo,
        track: { x: [[slabFrom, centreX]], y: [[slabFrom, cy]], skx, rz },
        clip,
        path: centredRect(hero.slabW, hero.slabH),
        fill: { colour: input.colours.highlight },
      } satisfies ShapePiece);
      const t0 = ws - 60;
      pieces.push({
        id: `velocity:${cueNumber}:hero`,
        kind: "text",
        z: base + 2,
        fromMs: t0,
        toMs: slabTo,
        track: {
          x: [[t0, centreX - m * 0.8 * BODY * u], [t0 + 130, centreX, "out"]],
          y: [[t0, cy]],
          sx: [[t0, 1.25], [t0 + 170, 1, "out"]],
          skx: [[t0, m * deg(k)]],
          rz,
          o: [[t0, 0], [t0 + 40, 1]],
        },
        clip,
        origin: { dx: hero.heroBox / 2, dy: -hero.cap / 2 },
        text: texts[heroAt]!,
        face: FACE,
        sizePx: heroSize,
        letterSpacingEm: LETTER_SPACING,
        fill: input.colours.accent,
        anchor: "baseline-left",
        language: cue.language,
      } satisfies TextPiece);
    }
  } else if (longest) {
    const found = longest as { left: number; boxWidth: number; top: number; cap: number; startMs: number };
    anchor = { lead: m > 0 ? found.left : found.left + found.boxWidth, top: found.top, height: found.cap, startMs: found.startMs };
  }

  // Speed lines: behind the slab, or behind the longest word of a no-hero cue; they trail the slanted lead edge.
  if (anchor) {
    const picks = lineCount === 4 ? [0, 1, 2, 3] : lineCount === 2 ? [1, 3] : [];
    const lineHeight = Math.round(0.055 * BODY) * u;
    picks.forEach((j, n) => {
      const t0 = anchor.startMs - 20 + n * 28;
      const fromMs = t0;
      const toMs = Math.min(t0 + 340, fadeTo);
      if (toMs <= fromMs) return;
      const length = LENS[j]! * BODY * u;
      const travel = 1.1 * BODY * u;
      const lean = k * (FRACS[j]! - 0.5) * anchor.height;
      const leadEdge = anchor.lead + m * lean;
      const pivotX = leadEdge - m * 14 * u + m * 0.35 * BODY * u;
      const pivotY = anchor.top + FRACS[j]! * anchor.height + lineHeight / 2;
      const alpha = (t: number) => kf(t, [[t0, 0], [t0 + 50, 1], [t0 + 160, 1], [t0 + 340, 0, "in"]]) * fade(t);
      const reach = [pivotX, pivotX - m * (length + travel)];
      const track: ShapePiece["track"] = {
        x: [[t0, pivotX], [t0 + 340, pivotX - m * travel, "out"]],
        y: [[t0, pivotY]],
        sx: [[t0, 0.55], [t0 + 140, 1, "out"]],
        o: sampled(alpha, [t0, t0 + 50, t0 + 160, t0 + 340, fadeFrom, fadeTo], fromMs, toMs, 0.01),
      };
      // A streak behind a slab as wide as the screen would pass the safe area: cut it there.
      const outside = Math.min(...reach) < space.safe.x1 || Math.max(...reach) > space.safe.x2;
      pieces.push({
        id: `velocity:${cueNumber}:line${j}`,
        kind: "shape",
        z: zBase + 1,
        fromMs,
        toMs,
        track,
        ...(outside
          ? { clip: { x1: [[fromMs, space.safe.x1]], x2: [[fromMs, space.safe.x2]], y1: [[fromMs, space.safe.y1]], y2: [[fromMs, space.safe.y2]] } satisfies Clip }
          : {}),
        path: roundedRectPath(m > 0 ? -length : 0, -lineHeight / 2, length, lineHeight, 3 * u),
        fill: { colour: LINE.colour, alpha: LINE.alpha },
      } satisfies ShapePiece);
    });
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const velocityProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number)) };
  },
};
