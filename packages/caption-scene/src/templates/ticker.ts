import type { DemoScript } from "../demo";
import { EASES, type Ease, type Frames, clamp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, rowWidth, rowsFromRoles, sceneSpace } from "../layout";
import type { Clip, PathCmd, Piece, ShapePiece, TextPiece } from "../scene";
import { rectPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Ticker (`samples/templates/30-ticker.js`): a signal-yellow tape band slams across the frame at the
 * hero's spoken start and carries the hero as a marquee (copies of the word with a four-point star
 * between them, scrolling left at 200 px/s). Support words ride above the tape's left half and below
 * its right half with a hard black shadow; a cue without a hero gets a slim black tape tilted the
 * other way with the words in white. The tape wipes away toward the right as the next cue starts.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`
 * and a scratch probe of `offsetLeft/Top`): the band is 1420 px wide (170 px past each frame edge) and
 * 1.5 cap heights tall (155 px at 150 px Archivo Black), tilted -4 degrees about its centre, which sits on the
 * anchor line (y 1300); the hero's baseline is half a cap height under the band's centre; the lead row's
 * bottom is 22 px above the band and starts 440 px left of centre, the tail row's top is 34 px below it and ends
 * 422 px right of centre. A plain cue's band is 1.55 em tall (102 px), tilted +3, its row centred, the baseline
 * 24 px under the centre.
 *
 * Pieces: the tape is one rectangle shape scaled about its left end (the wipe), so the wipe edges lean with the tape exactly
 * as the sample's `clip-path` on the tilted band does. Its hard shadow (the tape moved 12 px down in its own frame, of which only
 * a 12 px strip shows) and its keylines are rows of static 180 px segments, wiped by the canvas clip like the marquee copies, the
 * stars and a plain row's words (the sample's edge leans 4 degrees there, the clip is canvas-fixed; at 4 px and a word's height the
 * difference is under 4 px, spec section 7). Segments, not whole strips: libass blends a bitmap's bounding box, which for a long
 * thin tilted strip is mostly empty. A word is two pieces, its pop and its rest, so the rest is one still event.
 * Everything that runs past the frame on purpose (tape, strips, copies, stars) has `bleed`.
 */

export const TICKER_DEMO: DemoScript = {
  lines: [
    "here's:b my:m hot:b take",
    "resale:b is:m dead:h@620 and:m nobody:b cares",
    "stop:b chasing:b hype:h@700",
    "wear:b what:m you:m love",
    "period.:h@900",
  ],
  options: { cueGap: 170, tail: 620 },
};

const ANCHOR_LINE = 1300;
const TILT = -4;
const TILT_PLAIN = 3;
const HERO_SIZE = 150;
const WORD_SIZE = 66;
/** Marquee speed, sample px per ms (200 px/s). */
export const TICKER_SPEED = 0.2;
const BAND_OVERHANG = 170;
const WIPE_IN = 240;
const WIPE_OUT = 160;
/** Wipes and pops start this early so the word is readable on its spoken start. */
const LEAD = 60;
const HERO_FACE = "Archivo Black" as const;
const WORD_FACE = "Inter Tight ExtraBold" as const;
/** Archivo Black's cap height over its size (`CAPTION_FONT_FACES`); the band is 1.5 of it. */
const CAP = 0.688;
const BAND_CAPS = 1.5;
const HERO_LS = -0.01;
const WORD_LS = -0.01;
const STAR = 58;
const STAR_GAP = 46;
const KEY = 4;
const KEY_INSET = 9;
const PLAIN_BAND_EM = 1.55;
const PLAIN_KEY = 3;
const PLAIN_KEY_INSET = 7;
const PLAIN_GAP_EM = 0.26;
/** Baseline of a plain word under the band's centre, em (24 px at 66). */
const PLAIN_BASELINE_EM = 24 / 66;
/** `transform-origin: 50% 70%` of a word's box, and the baseline of a `line-height: 1` Inter Tight box, em. */
const WORD_PIVOT_Y = 0.7;
const WORD_BASELINE = 0.862;
const ROW_GAP_EM = 0.24;
/** A wrapped row's pitch, em (the sample never wraps). */
const ROW_PITCH_EM = 1.12;
const LEAD_ROW = { left: -440, above: 22 } as const;
const TAIL_ROW = { right: 422, below: 34 } as const;
/** Length of a static strip's segment and how far past the frame one is still kept, sample px. */
const SEGMENT = 180;
const SEGMENT_MARGIN = 80;
const OUT_FADE = 80;
const OUT_DRIFT = 28;
const POP_MS = 260;
const IN_FADE = 50;
const SHADOW = { dy: 12, alpha: 0.55 } as const;
const HARD = { stroke: 3.5, dx: 5, dy: 7 } as const;
/** Widest a row may be before it shrinks or wraps, share of the canvas width (the safe area). */
const MAX_ROW_SHARE = 0.9;
/** The pop's spring overshoots to `0.8 + 0.2 * 1.135` of the word's size; a word's outline, hard shadow and tilt add about 10 px each way. */
const POP_PEAK = 1.0271;
const WORD_REACH = 20;

const deg = (degrees: number) => (degrees * Math.PI) / 180;

interface Win {
  readonly start: number;
  readonly dur: number;
  readonly ease: Ease;
}

/**
 * `fn` as keyframes from `fromMs` where it is one eased window after another (exact eased segments), else sampled.
 * Windows that ended before `fromMs` are dropped: `fn` is already at their end value there.
 */
function windowed(fromMs: number, wins: readonly Win[], fn: (t: number) => number): Frames {
  const live = wins.filter((win) => win.start + win.dur > fromMs).sort((a, b) => a.start - b.start);
  if (live.length === 0) return [[fromMs, fn(fromMs)]];
  const ordered = live.every((win, at) => (at === 0 ? win.start >= fromMs : win.start >= live[at - 1]!.start + live[at - 1]!.dur));
  if (!ordered) return sampleFrames(fn, [fromMs, ...live.flatMap((win) => [win.start, win.start + win.dur]).filter((t) => t >= fromMs)], 0.05);
  const frames: [number, number, Ease?][] = [[fromMs, fn(fromMs)]];
  for (const win of live) {
    if (win.start > frames[frames.length - 1]![0]) frames.push([win.start, fn(win.start)]);
    frames.push([win.start + win.dur, fn(win.start + win.dur), win.ease]);
  }
  return frames;
}

/** The sample's four-point star (`viewBox -50 -50 100 100`), scaled to `size` and centred on (0, 0). */
function starShape(size: number): PathCmd[] {
  const k = size / 100;
  const c = (...v: number[]) => ["C", ...v.map((n) => n * k)] as unknown as PathCmd;
  return [["M", 0, -50 * k], c(6, -12, 12, -6, 50, 0), c(12, 6, 6, 12, 0, 50), c(-6, 12, -12, 6, -50, 0), c(-12, -6, -6, -12, 0, -50), ["Z"]];
}

interface PlacedWord {
  readonly index: number;
  /** Left edge of the word's box, sample px from the band's centre. */
  readonly left: number;
  readonly box: number;
  /** Baseline and pivot, sample px from the band's centre. */
  readonly baseline: number;
  readonly pivotY: number;
  readonly size: number;
}

function buildCue(cue: SceneCue, input: SceneInput, cueNumber: number): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u } = space;
  const sampleWidth = space.canvas.width / u;
  const bandW = sampleWidth + 2 * BAND_OVERHANG;
  const maxRow = (MAX_ROW_SHARE * sampleWidth) / POP_PEAK - WORD_REACH;
  const direction = cueDirection(cue);
  const { lead, hero, tail } = rowsFromRoles(cue.words.map((word) => word.role));
  const plain = hero.length === 0;
  const tilt = plain ? TILT_PLAIN : TILT;
  const cos = Math.cos(deg(tilt));
  const sin = Math.sin(deg(tilt));
  const centre = { x: space.x(540), y: space.y(ANCHOR_LINE) };
  /** Canvas position of a point `(xc, yc)` sample px from the band's centre, in the band's tilted frame. */
  const at = (xc: number, yc: number) => ({ x: centre.x + u * (xc * cos - yc * sin), y: centre.y + u * (xc * sin + yc * cos) });
  /** Sample-px advance and box of a text at a sample-px size. */
  const sizeOf = (text: string, face: typeof HERO_FACE | typeof WORD_FACE, size: number, ls: number) => {
    const m = input.measure(text, face, size * u, ls);
    return { advance: m.advance / u, box: m.advance / u + ls * size };
  };

  const heroStart = plain ? cue.startMs : cue.words[hero[0]!]!.startMs;
  const bandStart = heroStart - LEAD;
  const inEnd = bandStart + WIPE_IN;
  const outStart = cue.endMs - WIPE_OUT;
  const wipeIn = (t: number) => EASES.outExpo(prog(t, bandStart, WIPE_IN));
  const wipeOut = (t: number) => EASES.inOut(prog(t, outStart, WIPE_OUT));
  const wipeWins: Win[] = [
    { start: bandStart, dur: WIPE_IN, ease: "outExpo" },
    { start: outStart, dur: WIPE_OUT, ease: "inOut" },
  ];
  const z = cueNumber * 8;
  const pieces: Piece[] = [];

  // Hero size and band height. The hero never wraps: a word wider than a row shrinks the whole system.
  const heroText = plain ? "" : hero.map((index) => cue.words[index]!.text).join(" ").toUpperCase();
  const heroFit = plain ? 1 : fitScale(sizeOf(heroText, HERO_FACE, HERO_SIZE, HERO_LS).box, MAX_ROW_SHARE * sampleWidth);
  const heroSize = HERO_SIZE * heroFit;
  // The plain row is one line: a word too wide for it shrinks the line (and the tape with it).
  const plainTexts = plain ? cue.words.map((word) => word.text.toUpperCase()) : [];
  const plainBoxes = (size: number) => plainTexts.map((text) => sizeOf(text, WORD_FACE, size, WORD_LS).box);
  const plainSize = plain ? WORD_SIZE * fitScale(rowWidth(plainBoxes(WORD_SIZE), plainTexts.map((_, at) => at), PLAIN_GAP_EM * WORD_SIZE), maxRow) : WORD_SIZE;
  const bandH = plain ? Math.round(plainSize * PLAIN_BAND_EM) : Math.round(heroSize * CAP * BAND_CAPS);

  // The wipe as keyframes of `fn(wipeIn, wipeOut)`: exact eased segments while the two windows do not meet, sampled when they do.
  const wipeTrack = (from: number, fn: (wipeInNow: number, wipeOutNow: number) => number): Frames =>
    windowed(from, wipeWins, (t) => fn(wipeIn(t), wipeOut(t)));
  const edgeX = (xc: number) => centre.x + u * xc * cos;
  // The clip of everything the band's overflow cuts: the wipe's two ends at the centre line, in canvas px, with a tall box.
  const clipFrom = (from: number): Clip => {
    const half = u * (bandW * Math.abs(sin) + bandH + 80);
    return {
      x1: wipeTrack(from, (inn, out) => edgeX(bandW * Math.min(inn, out) - bandW / 2)),
      x2: wipeTrack(from, (inn) => edgeX(bandW * inn - bandW / 2)),
      y1: [[from, centre.y - half]],
      y2: [[from, centre.y + half]],
    };
  };

  // The tape is one rectangle scaled about its left end. Its shadow (the tape moved 12 px down in its own frame; only the strip
  // under the lower edge shows) and its keylines are static strips cut in segments and wiped by the canvas clip: libass blends
  // a bitmap's whole bounding box, and a long thin tilted strip's box is mostly empty.
  const visibleLeft = -centre.x / u - SEGMENT_MARGIN;
  const visibleRight = (space.canvas.width - centre.x) / u + SEGMENT_MARGIN;
  const strip = (id: string, yc: number, height: number, z0: number, fill: ShapePiece["fill"], overlap: number) => {
    let k = 0;
    for (let x0 = -bandW / 2; x0 < bandW / 2; x0 += SEGMENT, k++) {
      const x1 = Math.min(x0 + SEGMENT, bandW / 2);
      if (x1 <= visibleLeft || x0 >= visibleRight) continue;
      const from = x0 - overlap;
      const origin = at(from, yc);
      pieces.push({
        id: `${id}${k}`,
        kind: "shape",
        z: z0,
        fromMs: bandStart,
        toMs: cue.endMs,
        bleed: true,
        track: { x: [[bandStart, origin.x]], y: [[bandStart, origin.y]], rz: [[bandStart, tilt]] },
        clip: clipFrom(bandStart),
        path: rectPath(0, (-height / 2) * u, (x1 + overlap - from) * u, height * u),
        fill,
      });
    }
  };
  strip(`ticker:${cueNumber}:shadow`, bandH / 2 + SHADOW.dy / 2, SHADOW.dy, z, { colour: input.colours.shadow, alpha: SHADOW.alpha }, 0);
  pieces.push({
    id: `ticker:${cueNumber}:band`,
    kind: "shape",
    z: z + 1,
    fromMs: bandStart,
    toMs: cue.endMs,
    bleed: true,
    track: {
      x: wipeTrack(bandStart, (_in, out) => at(-bandW / 2 + bandW * out, 0).x),
      y: wipeTrack(bandStart, (_in, out) => at(-bandW / 2 + bandW * out, 0).y),
      sx: wipeTrack(bandStart, (inn, out) => Math.max(0, inn - out)),
      rz: [[bandStart, tilt]],
    },
    path: rectPath(0, (-bandH / 2) * u, bandW * u, bandH * u),
    fill: { colour: plain ? input.colours.accent : input.colours.highlight },
  });
  const keys = plain
    ? ([PLAIN_KEY_INSET + PLAIN_KEY / 2 - bandH / 2, bandH / 2 - PLAIN_KEY_INSET - PLAIN_KEY / 2] as const)
    : ([KEY_INSET + KEY / 2 - bandH / 2, bandH / 2 - KEY_INSET - KEY / 2] as const);
  for (const [side, yc] of keys.entries()) {
    strip(`ticker:${cueNumber}:key${side}s`, yc, plain ? PLAIN_KEY : KEY, z + 1, { colour: plain ? input.colours.highlight : input.colours.accent }, 0.75);
  }

  // Words: pop in on their spoken start, fade and drift out as the tape leaves. A word is two pieces, the pop and what
  // follows: once the spring has settled the rest never changes until the exit, and a piece that never changes is rasterised
  // once by libass (a tail of 0.06 % scale would make every frame of the rest a fresh rasterisation of an outlined word).
  const drift = { dx: OUT_DRIFT * u * cos, dy: OUT_DRIFT * u * sin };
  const leave = (t: number) => EASES.in(prog(t, outStart, OUT_FADE));
  const exitWin: Win = { start: outStart, dur: OUT_FADE, ease: "linear" };
  const driftWin: Win = { start: outStart, dur: OUT_FADE, ease: "in" };
  const wordPieces = (placed: PlacedWord, hard: boolean, clip: boolean): TextPiece[] => {
    const word = cue.words[placed.index]!;
    const pivot = at(placed.left + placed.box / 2, placed.pivotY);
    const wf = word.startMs - LEAD;
    const popEnd = wf + POP_MS;
    const piece = (id: string, from: number, to: number, track: TextPiece["track"]): TextPiece => ({
      id: `ticker:${cueNumber}:${id}`,
      kind: "text",
      z: z + 3,
      fromMs: from,
      toMs: to,
      track,
      ...(clip ? { clip: clipFrom(from) } : {}),
      origin: { dx: (placed.box / 2) * u, dy: (placed.pivotY - placed.baseline) * u },
      text: word.text.toUpperCase(),
      face: WORD_FACE,
      sizePx: placed.size * u,
      letterSpacingEm: WORD_LS,
      fill: input.colours.primary,
      ...(hard
        ? {
            stroke: { widthPx: HARD.stroke * u, colour: input.colours.accent },
            shadows: [{ dx: HARD.dx * u, dy: HARD.dy * u, blur: 0, colour: input.colours.accent, alpha: 1 }],
          }
        : {}),
      anchor: "baseline-left",
      language: cue.language,
    });
    const scale = windowed(wf, [{ start: wf, dur: POP_MS, ease: "spring" }], (t) => 0.8 + 0.2 * EASES.spring(prog(t, wf, POP_MS)));
    // The exit begins before the pop has settled (a very short cue): one piece carries both.
    if (popEnd >= outStart || popEnd >= cue.endMs) {
      return [
        piece(`w${placed.index}`, wf, cue.endMs, {
          x: windowed(wf, [driftWin], (t) => pivot.x + drift.dx * leave(t)),
          y: windowed(wf, [driftWin], (t) => pivot.y + drift.dy * leave(t)),
          sx: scale,
          sy: scale,
          rz: [[wf, tilt]],
          o: windowed(wf, [{ start: wf, dur: IN_FADE, ease: "linear" }, exitWin], (t) => clamp((t - wf) / IN_FADE) * (1 - prog(t, outStart, OUT_FADE))),
        }),
      ];
    }
    return [
      piece(`w${placed.index}`, wf, popEnd, {
        x: [[wf, pivot.x]],
        y: [[wf, pivot.y]],
        sx: scale,
        sy: scale,
        rz: [[wf, tilt]],
        o: windowed(wf, [{ start: wf, dur: IN_FADE, ease: "linear" }], (t) => clamp((t - wf) / IN_FADE)),
      }),
      piece(`w${placed.index}s`, popEnd, cue.endMs, {
        x: windowed(popEnd, [driftWin], (t) => pivot.x + drift.dx * leave(t)),
        y: windowed(popEnd, [driftWin], (t) => pivot.y + drift.dy * leave(t)),
        rz: [[popEnd, tilt]],
        o: windowed(popEnd, [exitWin], (t) => 1 - prog(t, outStart, OUT_FADE)),
      }),
    ];
  };

  if (plain) {
    const boxes = plainBoxes(plainSize);
    const gap = PLAIN_GAP_EM * plainSize;
    const order = rowVisualOrder(plainTexts, direction);
    let x = -rowWidth(boxes, order, gap) / 2;
    for (const index of order) {
      const placed: PlacedWord = {
        index,
        left: x,
        box: boxes[index]!,
        baseline: PLAIN_BASELINE_EM * plainSize,
        pivotY: (WORD_PIVOT_Y - 0.5) * bandH,
        size: plainSize,
      };
      pieces.push(...wordPieces(placed, false, true));
      x += boxes[index]! + gap;
    }
  } else {
    const keySize = heroSize / HERO_SIZE;
    const box = sizeOf(heroText, HERO_FACE, heroSize, HERO_LS).box;
    const star = STAR * keySize;
    const gap = STAR_GAP * keySize;
    const unit = box + star + 2 * gap;
    const landing = inEnd;
    const baseline = (CAP * heroSize) / 2;
    const last = cue.endMs;
    // Copy k's left edge in band-x from the band's centre at time t: copy 0 is centred when the wipe lands.
    const copyLeft = (k: number, t: number) => -box / 2 + k * unit - TICKER_SPEED * (t - landing);
    const reach = Math.ceil((bandW + TICKER_SPEED * (last - bandStart)) / unit) + 2;
    for (let k = -reach; k <= reach; k++) {
      // Visible while any of it is inside the band: right of its left end and left of its right end.
      const copySpan = (width: number, offset: number) => {
        // left(t) + offset + width > -bandW / 2  and  left(t) + offset < bandW / 2, with left(t) = base - speed (t - landing)
        const base = -box / 2 + k * unit + offset;
        const tEnter = landing + (base - bandW / 2) / TICKER_SPEED;
        const tLeave = landing + (base + width + bandW / 2) / TICKER_SPEED;
        return { from: Math.max(bandStart, tEnter), to: Math.min(last, tLeave) };
      };
      const text = copySpan(box, 0);
      if (text.to > text.from) {
        const a = at(copyLeft(k, text.from), baseline);
        const b = at(copyLeft(k, text.to), baseline);
        pieces.push({
          id: `ticker:${cueNumber}:hero${k + reach}`,
          kind: "text",
          z: z + 2,
          fromMs: text.from,
          toMs: text.to,
          bleed: true,
          track: { x: [[text.from, a.x], [text.to, b.x]], y: [[text.from, a.y], [text.to, b.y]], rz: [[text.from, tilt]] },
          clip: clipFrom(text.from),
          text: heroText,
          face: HERO_FACE,
          sizePx: heroSize * u,
          letterSpacingEm: HERO_LS,
          fill: input.colours.accent,
          anchor: "baseline-left",
          language: cue.language,
        });
      }
      const starSpan = copySpan(star, box + gap);
      if (starSpan.to > starSpan.from) {
        const a = at(copyLeft(k, starSpan.from) + box + gap + star / 2, 0);
        const b = at(copyLeft(k, starSpan.to) + box + gap + star / 2, 0);
        pieces.push({
          id: `ticker:${cueNumber}:star${k + reach}`,
          kind: "shape",
          z: z + 2,
          fromMs: starSpan.from,
          toMs: starSpan.to,
          bleed: true,
          track: { x: [[starSpan.from, a.x], [starSpan.to, b.x]], y: [[starSpan.from, a.y], [starSpan.to, b.y]], rz: [[starSpan.from, tilt]] },
          clip: clipFrom(starSpan.from),
          path: starShape(star * u),
          fill: { colour: input.colours.accent },
        });
      }
    }

    // Lead words above the tape's left half, tail words below its right half (mirrored for a right-to-left cue).
    const rtl = direction === "rtl";
    const rowsOf = (indices: readonly number[], limit: number) => {
      if (indices.length === 0) return { size: WORD_SIZE, rows: [] as number[][], boxes: [] as number[] };
      const texts = indices.map((index) => cue.words[index]!.text.toUpperCase());
      const widest = Math.max(...texts.map((text) => sizeOf(text, WORD_FACE, WORD_SIZE, WORD_LS).box));
      const size = WORD_SIZE * fitScale(widest, limit);
      const boxes = texts.map((text) => sizeOf(text, WORD_FACE, size, WORD_LS).box);
      return { size, rows: balancedRows(boxes, ROW_GAP_EM * size, limit), boxes };
    };
    const place = (indices: readonly number[], limit: number, edge: "left" | "right", from: number, vertical: (rowAt: number, rowCount: number, size: number) => number) => {
      const { size, rows, boxes } = rowsOf(indices, limit);
      const gapPx = ROW_GAP_EM * size;
      rows.forEach((row, rowAt) => {
        const ordered = rowVisualOrder(row.map((at) => cue.words[indices[at]!]!.text), direction).map((at) => row[at]!);
        const width = rowWidth(boxes, ordered, gapPx);
        let x = edge === "left" ? from : from - width;
        const top = vertical(rowAt, rows.length, size);
        for (const at of ordered) {
          pieces.push(...wordPieces({ index: indices[at]!, left: x, box: boxes[at]!, baseline: top + WORD_BASELINE * size, pivotY: top + WORD_PIVOT_Y * size, size }, true, false));
          x += boxes[at]! + gapPx;
        }
      });
    };
    const half = sampleWidth * 0.45;
    const fitLimit = (available: number) => available / POP_PEAK - WORD_REACH;
    const leadTop = (rowAt: number, count: number, size: number) => -bandH / 2 - LEAD_ROW.above - size - (count - 1 - rowAt) * ROW_PITCH_EM * size;
    const tailTop = (rowAt: number, _count: number, size: number) => bandH / 2 + TAIL_ROW.below + rowAt * ROW_PITCH_EM * size;
    if (rtl) {
      place(lead, fitLimit(half - LEAD_ROW.left), "right", -LEAD_ROW.left, leadTop);
      place(tail, fitLimit(half + TAIL_ROW.right), "left", -TAIL_ROW.right, tailTop);
    } else {
      place(lead, fitLimit(half - LEAD_ROW.left), "left", LEAD_ROW.left, leadTop);
      place(tail, fitLimit(half + TAIL_ROW.right), "right", TAIL_ROW.right, tailTop);
    }
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const tickerProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number)) };
  },
};
