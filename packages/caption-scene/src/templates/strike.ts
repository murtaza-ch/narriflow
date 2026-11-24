import { captionColourContrast, normalizeProviderLanguageCode, toCaptionUpperCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Frames } from "../ease";
import { exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { cueDirection, fitScale, greedyRows, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import { type ColourFrames, mixColour, type Piece, type ShapePiece, type TextPiece, type Track } from "../scene";
import { roundedRectPath } from "../shapes";

/**
 * Strike, gallery 3's m29-strike: grey ghosts light as spoken, with a tint-to-solid hero
 * box, drawn-through negations and a vertical progress rail. Padded flex rows now fit
 * measured ink and mirror for RTL. Whole words use the renderers' normal glyph fallback.
 * Ghosts are separate from the readable faces. Handoffs shorten the incoming lead when
 * necessary and stack simultaneous speech, so the sample's early exit cannot cut a word.
 * Negations are matched only in English and dim in colour to preserve an opaque word.
 * The rail gets a growing entrance bracket and pulses at the words. Cheap flat drawings
 * and one small text shadow replace the sample's stacked shadows.
 */
export const STRIKE_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m motivation:h@560",
    "it:m doesn't:b show:b up:m first",
    "you:m never:b feel:b ready:h@540",
    "so:m start:h@520 anyway",
    "it's:m not:b about:m perfect:h@520",
    "keep:b going:b",
  ],
  options: { rate: 255, cueGap: 120 },
};

const FACE = "Montserrat ExtraBold";
const BODY = 92;
const ANCHOR = 1290;
const LEAD = 80;
const READ = 150;
const GHOST = 0.34;
const WHITE = "#FFFFFF";
const DARK = "#161008";
const ORANGE = "#F59A1B";
const PINK = "#E8176B";
const NEGATIONS = new Set(["not", "never", "no", "don't", "doesn't", "can't", "won't", "isn't", "nothing"]);
const TRACKED_SCRIPT = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{M}\p{N}\p{P}\s]+$/u;

interface Timing {
  cue: SceneCue;
  start: number;
  spoken: number;
  from: number;
  to: number;
}

type Space = ReturnType<typeof sceneSpace>;

function layoutCue(cue: SceneCue, input: SceneInput, space: Space, maxHeight: number) {
  const safeWidth = space.safe.x2 - space.safe.x1;
  const rtl = cueDirection(cue) === "rtl";
  const texts = cue.words.map((word) => toCaptionUpperCase(word.text, cue.language));
  const atScale = (q: number) => {
    const maxWidth = Math.min(880 * q, safeWidth - 46 * q);
    const words = texts.map((text) => {
      const spacing = TRACKED_SCRIPT.test(text) ? -0.01 : 0;
      const base = BODY * q;
      const natural = input.measure(text, FACE, base, spacing);
      const size = base * fitScale(natural.advance, maxWidth - 22 * q);
      const ink = size === base ? natural : input.measure(text, FACE, size, spacing);
      return { text, spacing, size, width: Math.max(1, ink.advance + spacing * size) + 22 * q, ink };
    });
    const widths = words.map((word) => word.width);
    const gap = 2 * q;
    const rows = greedyRows(widths, gap, maxWidth).map((row) => {
      const above = Math.max(...row.map((i) => Math.max(0.86 * words[i]!.size, -words[i]!.ink.inkTop)));
      const below = Math.max(...row.map((i) => Math.max(0.14 * words[i]!.size, words[i]!.ink.inkBottom)));
      return { row, above, below, width: rowWidth(widths, row, gap) };
    });
    const height = rows.reduce((sum, row) => sum + row.above + row.below + 20 * q, 0) - 8 * q;
    return { q, words, rows, height, gap };
  };

  let fitted = atScale(space.u);
  for (let attempt = 0; attempt < 6 && fitted.height > maxHeight; attempt++) {
    // Scaling changes wrapping and the fallback face's rounded metrics.
    fitted = atScale(fitted.q * fitScale(fitted.height, maxHeight) * 0.98);
  }
  const { q, words, rows, height, gap } = fitted;
  const width = 30 * q + Math.max(...rows.map((row) => row.width));
  const leading = rtl ? space.x(1000) : space.x(80);
  const left = clamp(rtl ? leading - width : leading, space.safe.x1 + 4 * q, space.safe.x2 - width - 4 * q);
  const right = left + width;
  const railX = rtl ? right - 6 * q : left;
  const boxes: {
    left: number;
    top: number;
    baseline: number;
    height: number;
    word: (typeof words)[number];
    index: number;
  }[] = [];
  let top = 0;
  for (const { row, above, below, width: rowSpan } of rows) {
    let x = rtl ? right - 30 * q - rowSpan : left + 30 * q;
    const order = rowVisualOrder(
      row.map((i) => words[i]!.text),
      rtl ? "rtl" : "ltr",
    );
    const rowHeight = above + below + 12 * q;
    for (const visual of order) {
      const index = row[visual]!;
      const word = words[index]!;
      boxes.push({ left: x, top, baseline: top + above + 5 * q, height: rowHeight, word, index });
      x += word.width + gap;
    }
    top += rowHeight + 8 * q;
  }
  return { boxes, q, rtl, railX, left, right, height };
}

type Layout = ReturnType<typeof layoutCue>;

function isNegation(text: string): boolean {
  return NEGATIONS.has(text.toLowerCase().replace(/[’ʼ]/gu, "'").replace(/^\p{P}+|\p{P}+$/gu, ""));
}

function inkFor(fill: string, primary: string): string {
  if (captionColourContrast(fill, primary) >= 3) return primary;
  return captionColourContrast(fill, WHITE) >= 3 ? WHITE : DARK;
}

function cueSeed(cue: SceneCue): number {
  let hash = cue.index;
  for (const word of cue.words) {
    for (const char of word.text) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  }
  return (hash >>> 0) / 2 ** 32;
}

function cuePieces(timing: Timing, layout: Layout, top: number, beatNumber: number, input: SceneInput): Piece[] {
  const { cue, start, spoken, from, to } = timing;
  const { q, rtl, boxes, railX, height } = layout;
  const { fps, colours } = input;
  const id = `strike:${cue.index}`;
  const pieces: Piece[] = [];
  const palette = [colours.highlight, ORANGE, PINK];
  const heroFill = palette[beatNumber % palette.length]!;
  const railFill = boxes.some(({ index }) => cue.words[index]!.role === "hero") ? heroFill : colours.primary;
  const english = normalizeProviderLanguageCode(cue.language) === "en";
  const exitFrom = Math.max(spoken + READ, to - 140);
  const exit = paintedFrameCount(exitFrom, to, fps) >= 2;
  const decoEnd = exit ? exitFrom : to;
  const fades = (opacity: number): Frames => (exit ? [[exitFrom, opacity], [to, 0, "in"]] : [[from, opacity]]);
  const shape = (
    name: string, z: number, x: number, y: number, w: number, h: number, r: number,
    fill: string, begin: number, end: number, track: Track, pivotX = 0, pivotY = 0,
  ): void => {
    if (paintedFrameCount(begin, end, fps) < 2) return;
    const piece: ShapePiece = {
      kind: "shape", id: `${id}:${name}`, z, fromMs: begin, toMs: end,
      path: roundedRectPath(0, 0, w, h, r), fill: { colour: fill },
      origin: { dx: pivotX, dy: pivotY },
      track: { x: [[begin, x + pivotX]], y: [[begin, y + pivotY]], ...track },
    };
    pieces.push(piece);
  };

  const railTop = top + 6 * q;
  const railHeight = height - 12 * q;
  shape("rail", 0, railX, railTop, 6 * q, railHeight, 3 * q, colours.primary, from, to, { o: fades(0.22) });
  shape("progress", 1, railX, railTop, 6 * q, railHeight, 3 * q, railFill, start, to, {
    sy: [[start, 0.025], [spoken, 1], ...(exit ? [[exitFrom, 1], [to, 0.025, "in"]] as const : [])],
    o: fades(1),
  });

  // Open toward the text and mirror from the other edge for RTL.
  const seed = cueSeed(cue);
  const gateWidth = (12 + 6 * seed) * q;
  const gateY = beatNumber % 2 === 0 ? railTop : railTop + railHeight - 4 * q;
  const gateEnd = Math.min(decoEnd, from + 310);
  const gateLand = Math.min(from + 95, exportFrameAtOrBefore(gateEnd - 1, fps));
  shape("gate", 2, rtl ? railX - gateWidth : railX + 6 * q, gateY, gateWidth, 4 * q, 1 * q, railFill, from, gateEnd, {
    sx: gateLand > from ? [[from, 0.3], [gateLand, 1, "out"]] : [[from, 1]],
    o: [[gateLand, 0.85], [gateEnd, 0.28, "in"]],
  }, rtl ? gateWidth : 0);

  for (const { left, top: rowTop, baseline, height: rowHeight, word, index } of boxes) {
    const spokenWord = cue.words[index]!;
    const first = Math.max(from, spokenWord.startMs - LEAD);
    const lastSpokenFrame = exportFrameAtOrBefore(spokenWord.endMs - 1, fps);
    const litAt = Math.min(spokenWord.startMs + 70, lastSpokenFrame);
    const negated = english && isNegation(spokenWord.text);
    const hero = spokenWord.role === "hero";
    const x = left + 11 * q;
    const y = top + baseline;
    const faceId = `${id}:w${index}`;
    const base: TextPiece = {
      kind: "text", id: faceId, z: 5, fromMs: first, toMs: to,
      text: word.text, face: FACE, sizePx: word.size, letterSpacingEm: word.spacing,
      fill: colours.primary, language: cue.language, anchor: "baseline-left",
      shadows: [{ dx: 0, dy: 2 * q, blur: 2 * q, colour: colours.shadow, alpha: 0.55 }],
      track: { x: [[first, x]], y: [[first, y]] },
    };
    if (paintedFrameCount(from, first, fps) >= 2) {
      pieces.push({
        ...base, id: `${faceId}ghost`, fromMs: from, toMs: first,
        track: { ...base.track, o: [[from, 0.18], [Math.min(from + 90, first), GHOST, "out"]] },
      });
    }

    const hasBox = hero && paintedFrameCount(first, to, fps) >= 2;
    const knockout = hasBox ? inkFor(heroFill, colours.primary) : colours.primary;
    const boxLanded = Math.max(first, Math.min(spokenWord.startMs + 190, lastSpokenFrame));
    const tint = Math.min(spokenWord.startMs + 35, first + 0.55 * (boxLanded - first));
    // On bright holders, switch to dark ink once the wipe covers the word and the tint is dense.
    const inkAt = Math.max(first + 0.52 * (boxLanded - first), tint + 0.33 * (boxLanded - tint));
    if (hasBox) {
      shape(`w${index}box`, 4, left, top + rowTop, word.width, rowHeight, 2 * q, heroFill, first, to, {
        sx: boxLanded > first ? [[first, 0.12], [boxLanded, 1, "outExpo"]] : [[first, 1]],
        o: boxLanded > first ? [[first, 0.26], [tint, 0.42, "out"], [boxLanded, 1, "out"], ...(exit ? fades(1) : [])] : fades(1),
      }, rtl ? word.width : 0);
    }

    const dimFrom = Math.max(hasBox ? boxLanded : first, spokenWord.startMs + 60);
    const dimEnd = Math.min(decoEnd, dimFrom + 200);
    const ground = hasBox ? heroFill : "#15111D";
    const dimmed = mixColour(knockout, ground, 0.33);
    const colour: ColourFrames = [
      [first, inkAt > first ? colours.primary : knockout],
      ...(knockout !== colours.primary && inkAt > first ? [[Math.max(first, inkAt - 1), colours.primary], [inkAt, knockout]] as const : []),
      ...(negated && dimEnd > dimFrom && captionColourContrast(dimmed, ground) >= 3 ? [[dimFrom, knockout], [dimEnd, dimmed, "out"]] as const : []),
    ];
    const opacity: Frames = litAt > first
      ? [[first, first < spokenWord.startMs ? GHOST : 0.64], [litAt, 1, "out"], ...(exit ? fades(1) : [])]
      : fades(1);
    pieces.push({ ...base, track: { ...base.track, o: opacity, colour } });

    if (negated) {
      const strokeFrom = spokenWord.startMs;
      const strokeAt = Math.min(spokenWord.endMs, strokeFrom + 245);
      const strikeColour = hasBox && captionColourContrast(colours.accent, heroFill) < 3 ? inkFor(heroFill, colours.accent) : colours.accent;
      const strikeWidth = word.width + 4 * q;
      shape(`w${index}strike`, 6, left - 2 * q, top + rowTop + rowHeight / 2 - 3 * q, strikeWidth, 10 * q, 1 * q, strikeColour, strokeFrom, to, {
        sx: [[strokeFrom, 0.12], [strokeAt, 1, "out"]],
        rz: [[strokeFrom, rtl ? 1.6 : -1.6]],
        o: fades(1),
      }, rtl ? strikeWidth : 0, 5 * q);
    }

    const step = clamp((spokenWord.startMs - start) / Math.max(1, spoken - start));
    const tickY = railTop + railHeight * (0.18 + 0.64 * step);
    const tickWidth = (6 + 3 * ((index + beatNumber) % 2) + 2 * seed) * q;
    const tickFrom = spokenWord.startMs;
    const tickTo = Math.min(decoEnd, tickFrom + 150);
    const tickLand = Math.min(tickFrom + 70, exportFrameAtOrBefore(tickTo - 1, fps));
    shape(`pulse${index}`, 2, rtl ? railX - tickWidth : railX + 6 * q, tickY, tickWidth, 3 * q, 1 * q, railFill, tickFrom, tickTo, {
      sx: tickLand > tickFrom ? [[tickFrom, 0.4], [tickLand, 1, "out"]] : [[tickFrom, 1]],
      o: [[tickLand, 0.85], [tickTo, 0.18, "in"]],
    }, rtl ? tickWidth : 0);
  }
  return pieces;
}

interface Placement {
  timing: Timing;
  layout: Layout;
  top: number;
}

/** Assign concurrent speech to lanes and fit the whole stack around the ordinary cue's anchor. */
function placeGroup(group: Timing[], input: SceneInput, space: Space): Placement[] {
  const laneEnds: number[] = [];
  const lanes = group.map(({ start, spoken }) => {
    const free = laneEnds.findIndex((end) => end <= start);
    const lane = free < 0 ? laneEnds.length : free;
    laneEnds[lane] = spoken;
    return lane;
  });
  const gap = Math.min(12 * space.u, (space.safe.y2 - space.safe.y1) / (2 * laneEnds.length));
  const room = (space.safe.y2 - space.safe.y1 - gap * (laneEnds.length - 1)) / laneEnds.length;
  const layouts = group.map(({ cue }) => layoutCue(cue, input, space, room));
  const heights = laneEnds.map(() => 0);
  layouts.forEach(({ height }, i) => {
    const lane = lanes[i]!;
    heights[lane] = Math.max(heights[lane]!, height);
  });
  const stackHeight = heights.reduce((sum, height) => sum + height, 0) + gap * (heights.length - 1);
  let bottom = clamp(space.y(ANCHOR) + heights[0]! / 2, space.safe.y1 + stackHeight, space.safe.y2);
  const centres = heights.map((height) => {
    const centre = bottom - height / 2;
    bottom -= height + gap;
    return centre;
  });
  return group.map((timing, i) => {
    const layout = layouts[i]!;
    const lane = lanes[i]!;
    return { timing, layout, top: centres[lane]! - layout.height / 2 };
  });
}

function intersects(a: Placement, b: Placement): boolean {
  return a.layout.left < b.layout.right && a.layout.right > b.layout.left &&
    a.top < b.top + b.layout.height && a.top + a.layout.height > b.top;
}

export const strikeProgram: SceneProgram = {
  build(input) {
    const space = sceneSpace(input, ANCHOR);
    const cues = input.cues.filter((cue) => cue.words.length > 0).map((cue): Timing => {
      const start = Math.min(...cue.words.map((word) => word.startMs));
      const spoken = Math.max(...cue.words.map((word) => word.endMs));
      return { cue, start, spoken, from: Math.max(0, start - LEAD), to: Math.max(cue.endMs, spoken) };
    });
    const groups: Timing[][] = [];
    let groupEnd = Number.NEGATIVE_INFINITY;
    for (const cue of cues) {
      if (cue.start >= groupEnd) {
        groups.push([]);
        groupEnd = cue.spoken;
      } else {
        groupEnd = Math.max(groupEnd, cue.spoken);
      }
      groups.at(-1)!.push(cue);
    }
    const placed = groups.flatMap((group) => placeGroup(group, input, space));

    // Compare all live blocks: a naturally separate lane can overlap, but a
    // colliding entrance gives the earlier speech its hold when the gap allows.
    let active: Placement[] = [];
    for (const current of placed) {
      const { timing } = current;
      active = active.filter((before) => before.timing.to > timing.from);
      const collisions = active.filter((before) => intersects(before, current));
      for (const { timing: before } of collisions) timing.from = Math.max(timing.from, Math.min(timing.start, before.spoken + READ));
      for (const { timing: before } of collisions) before.to = Math.min(before.to, timing.from);
      active.push(current);
    }
    let heroCount = 0;
    let plainCount = 0;
    return {
      pieces: placed.flatMap(({ timing, layout, top }) => {
        const hasHero = timing.cue.words.some((word) => word.role === "hero");
        const beat = hasHero ? heroCount++ : plainCount++;
        return cuePieces(timing, layout, top, beat, input);
      }),
    };
  },
};
