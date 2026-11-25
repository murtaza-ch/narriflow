import type { DemoScript } from "../demo";
import { type Ease, clamp, EASES, lerp, prog } from "../ease";
import { exportFrameAtOrBefore, exportFrameTimes, paintedFrameCount, SCENE_DEFAULT_FPS } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneInput, SceneProgram } from "../input";
import { balancedRows, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import { type Box, type ColourFrames, type Frames, type Piece, type TextPiece, pieceBounds } from "../scene";
import { ellipsePath, polygonPath, rectPath } from "../shapes";
import { galleryScene } from "./gallery-layout";
import { hasTwoPaintedFrames, type SpeechCell } from "./speech-layout";

/**
 * Chronicle (`samples/templates/m55-chronicle.js`): the transcript as a timeline. A tick for every spoken word of the
 * whole clip scrolls past an amber playhead under a left-aligned serif caption, so pauses read as gaps and the next
 * words are visible before they are said; a year in the speech rises as a huge outline numeral, digit by digit, and a
 * question raises a large outline question mark.
 *
 * Changes from the sample, and why:
 * - The timeline is clip-scoped: one strip for the whole clip (ticks, ruler graduations, baseline, playhead), built
 *   outside the cues. Its pieces are named `chronicle:tl:*`, so no cue owns them; ticks move linearly over their whole
 *   life (one `\move`), and each fades at the strip's edges as the sample's do.
 * - Years and questions are read from the spoken words only, for any language: a year is a four-digit number from 1500
 *   to 2099 in any script's decimal digits (shown in Latin digits, the one face drawn), with the punctuation around it
 *   and a decade `s` ignored; a question is a word that ends in a question mark of any script (`? ？ ؟ ⸮` or the Greek
 *   one). Nothing is invented: a numeral shows the digits the speaker's word has, a question mark the word's own.
 * - The sample's CSS stroke is centred, libass draws the band outside the glyph: the numerals are hollow with a 4.5 px
 *   band. Digits rise out of a window at the baseline from fully hidden (the sample's started a third showing) and the
 *   stroke is full from the start (a stroke width cannot animate).
 * - The sample lets a year stay 1.5 s after its cue. The port does too, but only while no later cue draws anywhere in
 *   the numeral's box, and it fades before the first frame that would; real cues are longer and denser than the demo.
 * - Fit: rows balance-wrap inside the column and shrink for a word wider than it, the numeral shrinks (down to 40 %,
 *   else it is left out) to fit above the text and inside the column, everything stays in the safe area at every
 *   aspect ratio, a right-to-left cue mirrors (text right-aligned, numeral on the left), and the whole strip moves up
 *   when a short canvas has no room under the text.
 * - The caption sits 8 px higher than the sample's so a descender never reaches the playhead's cap.
 * - Extra recurring beats (the sample has none): every cue gets a bracket under the baseline that spans its words,
 *   dim until the cue reaches the playhead and amber while it is spoken, and a ring pings from the playhead when a cue
 *   starts (small, light) and when a key word starts (larger, amber).
 */

export const CHRONICLE_DEMO: DemoScript = {
  lines: [
    "in:m 1969:b@640 humans:b walked:h@600",
    "on:m the:m moon:b",
    "so:m why:b did:m we:m ever:b stop?:h@640",
    "money:b+650 politics:b and:m fear:h@620",
    "by:m 1972:b@640 it:m was:m over:h@600",
  ],
  options: { rate: 290, cueGap: 200, tail: 900 },
};

/** The sample's row where the last caption line sits (its baseline), and where the timeline's baseline lies. */
const ANCHOR = 1370;
const LINE_Y = 1520;
const X0 = 86;
const X1 = 994;
const PLAY_X = 238;
/** Sample px per ms: the strip shows 3.6 s. */
const SPEED = 0.25;
const BODY = 72;
const HERO = Math.round(BODY * 1.4);
const YEAR_SIZE = Math.round(BODY * 3.9);
const ASK_SIZE = Math.round(BODY * 4.4);
const BODY_FACE = "Newsreader Medium";
const HERO_FACE = "Newsreader SemiBold Italic";
const NUMERAL_FACE = "DM Serif Display";
const LEAD = 60;
const LINGER_MS = 1500;
const LINGER_FADE = 300;
const MIN_NUMERAL = 0.4;

// ─── Reading the speech ──────────────────────────────────────────────────────

/** First code point of each script's 0-9 (ASCII, Arabic-Indic, Persian/Urdu, Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam, Thai, Lao, Myanmar, fullwidth). */
const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xe50, 0xed0, 0x1040, 0xff10];

function asciiDigit(char: string): string | null {
  const code = char.codePointAt(0)!;
  for (const zero of DIGIT_ZEROS) if (code >= zero && code < zero + 10) return String(code - zero);
  return null;
}

/** What may stand around a spoken year: spaces, quotes, brackets, dashes, stops and commas of any script, never a sign that changes what the number is (`%`, `$`, `#`). */
const AROUND = /^[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Pd}\s.,;:!?…。，、،؛؟"'`]+|[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Pd}\s.,;:!?…。，、،؛؟"'`]+$/gu;

/**
 * The year a spoken word names, as the digits to draw, or null. Four decimal digits of any script (1500 to 2099), an
 * optional decade `s`, any punctuation around them: `1969`, `"1969,"`, `(1969)`, `1990s`, `1990's`, `१९६९`.
 */
export function chronicleYear(text: string): string | null {
  const core = text.replace(AROUND, "");
  const decade = /['’]?s$/i.exec(core);
  const digits = [...(decade ? core.slice(0, decade.index) : core)].map(asciiDigit);
  if (digits.length !== 4 || digits.some((digit) => digit === null)) return null;
  const year = Number(digits.join(""));
  return year >= 1500 && year <= 2099 ? `${year}${decade ? "s" : ""}` : null;
}

/** Whether a spoken word ends in a question mark of any script (`?`, `？`, `؟`, `⸮`, the Greek one), `?!` and closing quotes included. */
export function asksQuestion(text: string): boolean {
  const ending = /[\p{P}\p{S}]+$/u.exec(text);
  return ending !== null && /[?？؟⸮;]/.test(ending[0]);
}

interface Feature {
  readonly kind: "year" | "ask";
  /** The word that starts it. */
  readonly at: number;
  readonly text: string;
}

function cueFeatures(words: readonly { readonly text: string }[]): Feature[] {
  const features: Feature[] = [];
  words.forEach((word, at) => {
    const year = chronicleYear(word.text);
    if (year) features.push({ kind: "year", at, text: year });
    if (asksQuestion(word.text)) features.push({ kind: "ask", at, text: "?" });
  });
  return features;
}

// ─── The strip ───────────────────────────────────────────────────────────────

interface Geometry {
  readonly u: number;
  readonly left: number;
  readonly right: number;
  readonly playX: number;
  /** Canvas px per ms. */
  readonly speed: number;
  /** The timeline's baseline. */
  readonly baseY: number;
  /** The baseline of a cue's last caption row. */
  readonly textBaseline: number;
  readonly from: number;
  readonly to: number;
}

function geometry(input: SceneInput): Geometry {
  const space = sceneSpace(input, ANCHOR);
  const { u, safe } = space;
  const left = Math.max(space.x(X0), safe.x1);
  const right = Math.min(space.x(X1), safe.x2);
  // A ring pings 60 px under the baseline: keep it inside the safe area on a short canvas.
  const baseY = Math.min(space.y(LINE_Y), safe.y2 - 64 * u);
  const words = input.cues.flatMap((cue) => cue.words);
  return {
    u, left, right,
    playX: left + ((PLAY_X - X0) / (X1 - X0)) * (right - left),
    speed: SPEED * u,
    baseY,
    textBaseline: baseY - (LINE_Y - ANCHOR + 8) * u,
    from: Math.max(0, Math.min(...words.map((word) => word.startMs)) - 100),
    to: Math.max(...input.cues.map((cue) => Math.max(cue.endMs, ...cue.words.map((word) => word.endMs)))),
  };
}

function sampled(fn: (t: number) => number, edges: readonly number[], from: number, to: number): Frames {
  if (to <= from) return [[from, fn(from)]];
  return sampleFrames(fn, edges, 0.004, { range: [from, to], simplify: true });
}

function timeline(input: SceneInput, geo: Geometry): Piece[] {
  const { u, left, right, playX, speed, baseY, from: tlFrom, to: tlTo } = geo;
  const c = input.colours;
  const edge = 60 * u;
  /** The strip fades in with the first cue and out with the last. */
  const strip = (t: number) => prog(t, tlFrom, 200) * (1 - prog(t, tlTo - 200, 200));
  const stripEdges = [tlFrom, tlFrom + 200, tlTo - 200, tlTo];
  const pieces: Piece[] = [];

  /** A piece that travels from the strip's right end to its left, `span` ms long, passing the playhead at `startMs`. */
  const lo = left + 5 * u;
  const hi = right - 5 * u;
  const travelling = (id: string, startMs: number, span: number) => {
    const enter = startMs - (hi - playX) / speed;
    const exit = startMs + span + (playX - lo) / speed;
    return {
      id, enter, exit, from: Math.max(enter, tlFrom), to: Math.min(exit, tlTo),
      x: [[enter, hi], [exit, lo - span * speed]] as Frames,
      // 0..1 across the strip's edges, for the piece's left end.
      edge: (t: number) => {
        const x = playX + (startMs - t) * speed;
        return clamp((x - lo) / edge) * clamp((hi - x) / edge);
      },
    };
  };

  const heights = { sentence: 72, hero: 54, minor: 22, body: 36 };
  for (const cue of input.cues) {
    cue.words.forEach((word, at) => {
      const hero = word.role === "hero";
      const h = (at === 0 ? heights.sentence : hero ? heights.hero : word.role === "minor" ? heights.minor : heights.body) * u;
      const w = (hero || at === 0 ? 6 : 4) * u;
      const move = travelling(`chronicle:tl:tick${cue.index}-${at}`, word.startMs, 0);
      if (move.to <= move.from) return;
      const opacity = (t: number) => move.edge(t) * (0.62 + 0.38 * prog(t, word.startMs, 33)) * strip(t);
      const edges = [move.enter, move.enter + edge / speed, word.startMs, word.startMs + 33, move.exit - edge / speed, move.exit, ...stripEdges];
      const bump: Frames = [[Math.min(move.from, word.startMs), 1], [word.startMs, 1], [word.startMs + 80, 1.5, "out"], [word.startMs + 200, 1, "in"]];
      const flash: ColourFrames = hero ? [[move.enter, c.highlight]] : [[move.enter, c.primary], [word.startMs, c.primary], [word.startMs + 33, c.highlight], [word.startMs + 200, c.highlight], [word.startMs + 260, c.primary]];
      pieces.push({
        id: move.id, kind: "shape", z: 2, fromMs: move.from, toMs: move.to, path: rectPath(-w / 2, -h, w, h), fill: { colour: hero ? c.highlight : c.primary },
        track: { x: move.x, y: [[move.enter, baseY]], sy: bump[0]![0] === word.startMs ? bump.slice(1) : bump, o: sampled(opacity, edges, move.from, move.to), colour: flash },
        shadows: [{ dx: 0, dy: u, blur: 2.5 * u, colour: c.shadow, alpha: 0.6 }],
      });
    });
  }

  // The ruler: a graduation every 250 ms, in step with the ticks (a tick is a word, a graduation is the clock).
  const clockFrom = Math.floor((tlFrom - (playX - lo) / speed) / 250) * 250;
  for (let at = clockFrom; at <= tlTo + (hi - playX) / speed; at += 250) {
    const move = travelling(`chronicle:tl:grad${at}`, at, 0);
    if (move.to <= move.from) continue;
    const opacity = (t: number) => 0.32 * move.edge(t) * strip(t);
    pieces.push({
      id: move.id, kind: "shape", z: 1, fromMs: move.from, toMs: move.to, path: rectPath(-u, -9 * u, 2 * u, 9 * u), fill: { colour: c.primary },
      track: { x: move.x, y: [[move.enter, baseY]], o: sampled(opacity, [move.enter, move.enter + edge / speed, move.exit - edge / speed, move.exit, ...stripEdges], move.from, move.to) },
    });
  }

  // Baseline.
  pieces.push({
    id: "chronicle:tl:line", kind: "shape", z: 2, fromMs: tlFrom, toMs: tlTo, path: rectPath(0, -1.5 * u, right - left, 3 * u), fill: { colour: c.primary },
    track: { x: [[tlFrom, left]], y: [[tlFrom, baseY]], o: sampled((t) => 0.6 * strip(t), stripEdges, tlFrom, tlTo) },
    shadows: [{ dx: 0, dy: u, blur: 3 * u, colour: c.shadow, alpha: 0.6 }],
  });

  // Playhead: an amber rule with a triangle cap, fixed.
  const fade = { o: sampled(strip, stripEdges, tlFrom, tlTo) };
  pieces.push({
    id: "chronicle:tl:playhead", kind: "shape", z: 4, fromMs: tlFrom, toMs: tlTo, path: rectPath(-1.5 * u, 0, 3 * u, 120 * u), fill: { colour: c.highlight },
    track: { x: [[tlFrom, playX]], y: [[tlFrom, baseY - 96 * u]], ...fade },
    shadows: [{ dx: 0, dy: 0, blur: 5 * u, colour: c.highlight, alpha: 0.45 }],
  });
  pieces.push({
    id: "chronicle:tl:cap", kind: "shape", z: 4, fromMs: tlFrom, toMs: tlTo, path: polygonPath([[-17 * u, 0], [17 * u, 0], [0, 26 * u]]), fill: { colour: c.highlight },
    track: { x: [[tlFrom, playX]], y: [[tlFrom, baseY - 118 * u]], ...fade },
    shadows: [{ dx: 0, dy: 2 * u, blur: 2 * u, colour: c.shadow, alpha: 0.6 }],
  });

  for (const cue of input.cues) {
    const first = cue.words[0];
    const last = cue.words.at(-1);
    if (!first || !last) continue;
    const span = last.endMs - first.startMs;

    // Beat 1: a bracket under the baseline spans the cue's words; amber while the cue is under the playhead.
    const move = travelling(`chronicle:tl:span${cue.index}`, first.startMs, span);
    if (move.to > move.from) {
      const opacity = (t: number) => (0.5 + 0.5 * prog(t, first.startMs, 60) * (1 - prog(t, last.endMs, 60))) * strip(t);
      pieces.push({
        id: move.id, kind: "shape", z: 2, fromMs: move.from, toMs: move.to, path: rectPath(0, 0, span * speed, 5 * u), fill: { colour: c.primary },
        track: {
          x: move.x, y: [[move.enter, baseY + 8 * u]], o: sampled(opacity, [first.startMs, first.startMs + 60, last.endMs, last.endMs + 60, ...stripEdges], move.from, move.to),
          colour: [[move.enter, c.primary], [first.startMs, c.primary], [first.startMs + 60, c.highlight], [last.endMs, c.highlight], [last.endMs + 60, c.primary]],
        },
        clip: { x1: [[move.from, left]], x2: [[move.from, right]], y1: [[move.from, baseY]], y2: [[move.from, baseY + 20 * u]] },
      });
    }

    // Beat 2: a ring pings from the playhead when the cue starts, and larger and amber when a key word does.
    const ping = (id: string, at: number, radius: number, colour: string, alpha: number) => {
      if (at < tlFrom || at + 360 > tlTo + 200) return;
      const to = Math.min(at + 360, tlTo);
      pieces.push({
        id: `chronicle:tl:${id}`, kind: "shape", z: 3, fromMs: at, toMs: to, path: ellipsePath(0, 0, radius), stroke: { widthPx: 3 * u, colour },
        track: { x: [[at, playX]], y: [[at, baseY]], sx: [[at, 0.2], [at + 360, 1, "out"]], sy: [[at, 0.2], [at + 360, 1, "out"]], o: [[at, alpha], [at + 360, 0, "in"]] },
      });
    };
    ping(`ring${cue.index}`, first.startMs, 30 * u, c.primary, 0.7);
    cue.words.forEach((word, at) => {
      if (word.role === "hero" && at > 0) ping(`ringhero${cue.index}-${at}`, word.startMs, 56 * u, c.highlight, 0.9);
    });
  }
  return pieces.filter((piece) => hasTwoPaintedFrames(piece, input));
}

// ─── The cues ────────────────────────────────────────────────────────────────

const rowGap = 0.14 * BODY;
const wordGap = 0.26 * BODY;

function chronicleCaptions(input: SceneInput, geo: Geometry, linger: ReadonlyMap<number, number>): readonly Piece[] {
  return galleryScene("chronicle", ANCHOR, (ctx) => {
    const { cue, index, to, from: windowFrom, bounds } = ctx.window;
    const c = ctx.input.colours;
    const { fps, side } = ctx;
    const u = ctx.space.u;
    const direction = ctx.rtl ? "rtl" : "ltr";
    const colLeft = Math.max(geo.left, bounds.x1 + 4);
    const colRight = Math.min(geo.right, bounds.x2 - 4);
    const words = cue.words.map((word) => ({ text: word.text, hero: word.role === "hero", face: (word.role === "hero" ? HERO_FACE : BODY_FACE) as TextPiece["face"], size: word.role === "hero" ? HERO : BODY }));

    const compose = (f: number) => {
      const un = u * f;
      const sizes = words.map((word) => word.size * un);
      const ms = words.map((word, at) => ctx.input.measure(word.text, word.face, sizes[at]!, 0));
      const gap = wordGap * un;
      const rows = balancedRows(ms.map((m) => m.advance), gap, colRight - colLeft);
      const info = rows.map((row) => ({
        row,
        size: Math.max(...row.map((at) => sizes[at]!)),
        up: Math.max(...row.map((at) => -ms[at]!.inkTop)),
        down: Math.max(...row.map((at) => ms[at]!.inkBottom)),
      }));
      const last = info.at(-1)!;
      const baselines: number[] = [];
      baselines[info.length - 1] = Math.min(geo.textBaseline, bounds.y2 - last.down - 2);
      for (let r = info.length - 2; r >= 0; r--) {
        const pitch = Math.max(0.05 * info[r]!.size + rowGap * un + 0.95 * info[r + 1]!.size, info[r]!.down + info[r + 1]!.up + 4 * un);
        baselines[r] = baselines[r + 1]! - pitch;
      }
      const cells: SpeechCell[] = [];
      info.forEach(({ row }, r) => {
        const width = rowWidth(ms.map((m) => m.advance), row, gap);
        let x = direction === "rtl" ? colRight - width : colLeft;
        for (const i of rowVisualOrder(row.map((at) => words[at]!.text), direction)) {
          const at = row[i]!;
          const m = ms[at]!;
          cells.push({ at, text: words[at]!.text, face: words[at]!.face, spacing: 0, size: sizes[at]!, x: x + m.advance / 2, baseline: baselines[r]!, width: m.advance, inkTop: m.inkTop, inkBottom: m.inkBottom });
          x += m.advance + gap;
        }
      });
      const topInk = baselines[0]! - info[0]!.up;
      return { cells, un, topInk, bottomInk: baselines.at(-1)! + last.down };
    };

    // The widest word sets the size (a word cannot wrap), then the block must fit under the top of its lane.
    const widest = Math.max(...words.map((word) => ctx.input.measure(word.text, word.face, word.size * u, 0).advance));
    let f = Math.min(1, (colRight - colLeft) / Math.max(1, widest));
    let block = compose(f);
    for (let tries = 0; tries < 6 && block.topInk < bounds.y1 + 2; tries++) {
      f *= Math.max(0.5, ((block.bottomInk - bounds.y1 - 2) / (block.bottomInk - block.topInk)) * 0.99);
      block = compose(f);
    }
    const un = block.un;

    const exitAt = ctx.exitAt;
    const pieces: Piece[] = [];
    const shadows = [{ dx: 0, dy: 2 * un, blur: 5 * un, colour: c.shadow, alpha: 0.75 }, { dx: 0, dy: un, blur: 1.2 * un, colour: c.shadow, alpha: 0.8 }];

    // Words: fade up out of a small blur at the spoken start.
    for (const cell of block.cells) {
      const word = cue.words[cell.at]!;
      const begin = word.startMs - LEAD;
      const from = Math.max(windowFrom, begin);
      const last = exportFrameAtOrBefore(word.endMs - 1, fps);
      const dur = Math.max(1, Math.min(120, last - begin));
      const opacity = (t: number) => EASES.out(prog(t, begin, dur));
      const opaqueAt = Math.max(from, begin + dur);
      const o: [number, number, Ease?][] = sampled(opacity, [begin, begin + dur], from, Math.max(from + 1, opaqueAt)).map((frame) => [...frame] as [number, number, Ease?]);
      if (ctx.exit) o.push([Math.max(exitAt, (o.at(-1)![0]) + 1), 1], [to, 0, "in"]);
      const blur: Frames = begin + 160 > from ? [[from, lerp(0.05 * cell.size, 0, prog(from, begin, 160))], [begin + 160, 0]] : [[from, 0]];
      const face = ctx.face(cell, from, word.role === "hero" ? c.highlight : c.primary, { o, blur });
      pieces.push({ ...face, shadows });
    }

    // Years and questions: a huge outline numeral above the text, on the side opposite the text's alignment.
    const features = cueFeatures(cue.words);
    const numeralStrokes = 4.5 * un;
    features.forEach((feature, k) => {
      const word = cue.words[feature.at]!;
      const nominal = (feature.kind === "year" ? YEAR_SIZE : ASK_SIZE) * un;
      const inkBottom = block.topInk - 40 * un;
      const m = ctx.input.measure(feature.text, NUMERAL_FACE, nominal, 0);
      // The mark swings 12 degrees about its lower left, so its top corner passes 0.16 em beyond where it settles.
      const swing = feature.kind === "ask" ? 0.16 : 0;
      const fit = Math.min(1, (inkBottom - bounds.y1 - 4 * un) / (m.inkBottom - m.inkTop), (colRight - colLeft - 2 * numeralStrokes) / (m.advance + swing * nominal));
      if (fit < MIN_NUMERAL) return;
      const size = nominal * fit;
      const sized = ctx.input.measure(feature.text, NUMERAL_FACE, size, 0);
      const baseline = inkBottom - sized.inkBottom;
      const left = ctx.rtl ? colLeft + numeralStrokes + swing * size : colRight - numeralStrokes - swing * size - sized.advance;
      const start = Math.max(windowFrom, word.startMs - LEAD);
      const next = features[k + 1];
      const nextStart = next ? Math.max(windowFrom, cue.words[next.at]!.startMs - LEAD) : Infinity;
      const lingerEnd = feature.kind === "year" && !next ? linger.get(index) : undefined;
      const end = Math.min(lingerEnd ?? to, nextStart);
      const lingering = lingerEnd !== undefined && lingerEnd > to && end === lingerEnd;
      const fadeStart = lingering ? end - LINGER_FADE : end === to ? exitAt : end - 140;
      const finish = (o: [number, number, Ease?][]) => {
        if (ctx.exit || end !== to) {
          const start = Math.max(fadeStart, o.at(-1)![0] + 1);
          o.push([start, o.at(-1)![1]], [Math.max(end, start + 1), 0, "in"]);
        }
        return o;
      };
      if (feature.kind === "ask") {
        // The mark turns up from the lower left of its box (the sample's 30 % / 90 % origin) and settles upright.
        const at = start;
        if (paintedFrameCount(at, end, fps) < 2) return;
        const origin = { dx: -0.2 * sized.advance * side, dy: 0.05 * size };
        pieces.push({
          id: `${ctx.id}:ask${k}`, kind: "text", z: 4, fromMs: at, toMs: end, text: "?", face: NUMERAL_FACE, sizePx: size, letterSpacingEm: 0,
          fill: c.primary, fillAlpha: 0, stroke: { widthPx: numeralStrokes, colour: c.primary }, anchor: "baseline-center", language: cue.language, origin,
          track: {
            x: [[at, left + sized.advance / 2 + origin.dx]],
            y: [[at, baseline + origin.dy + 40 * un], [at + 320, baseline + origin.dy, "out"]],
            rz: [[at, 12 * side], [at + 320, 0, "out"]],
            o: finish([[at, 0], [at + 320, 0.9, "out"]]),
          },
        });
        return;
      }
      // Digit i rises from behind the numeral's baseline at 50 i ms and 1 em of travel, in a window that hides it until then.
      [...feature.text].forEach((digit, i) => {
        const prefix = feature.text.slice(0, i);
        const x0 = prefix ? ctx.input.measure(prefix, NUMERAL_FACE, size, 0).advance : 0;
        const w = ctx.input.measure(digit, NUMERAL_FACE, size, 0).advance;
        const at = start + i * 50;
        if (paintedFrameCount(at, end, fps) < 2) return;
        const cx = left + x0 + w / 2;
        const o = finish([[at, 1]]);
        pieces.push({
          id: `${ctx.id}:num${k}d${i}`, kind: "text", z: 4, fromMs: at, toMs: end, text: digit, face: NUMERAL_FACE, sizePx: size, letterSpacingEm: 0,
          fill: c.primary, fillAlpha: 0, stroke: { widthPx: numeralStrokes, colour: c.primary, alpha: 0.92 }, anchor: "baseline-center", language: cue.language,
          track: { x: [[at, cx]], y: [[at, baseline + size], [at + 300, baseline, "out"]], o },
          clip: { x1: [[at, cx - w / 2 - 2 * numeralStrokes]], x2: [[at, cx + w / 2 + 2 * numeralStrokes]], y1: [[at, baseline - size]], y2: [[at, baseline + 0.04 * size]] },
        });
      });
    });
    return pieces;
  }).build(input).pieces;
}

/** Cue of a piece, or NaN for the timeline's. */
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const meets = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

/**
 * How long each cue's year stays after its cue. The sample keeps it 1.5 s (and so over the next cue); real cues are denser,
 * so it stays only while nothing of a later cue draws inside its box, and fades out ahead of the first frame that would.
 */
function lingers(pieces: readonly Piece[], input: SceneInput): Map<number, number> {
  const fps = input.fps ?? SCENE_DEFAULT_FPS;
  const clipEnd = Math.max(...pieces.map((piece) => piece.toMs));
  const years = new Map<number, Piece[]>();
  for (const piece of pieces) {
    if (/^chronicle:\d+:num\d+d\d+$/.test(piece.id)) years.set(cueOf(piece), [...(years.get(cueOf(piece)) ?? []), piece]);
  }
  const out = new Map<number, number>();
  for (const [index, digits] of years) {
    const to = Math.max(...digits.map((piece) => piece.toMs));
    const settled = Math.max(...digits.map((piece) => piece.fromMs)) + 320;
    if (settled >= to) continue;
    const boxes = digits.flatMap((piece) => pieceBounds(piece, settled, input.measure) ?? []);
    if (boxes.length === 0) continue;
    const box = { x1: Math.min(...boxes.map((b) => b.x1)), y1: Math.min(...boxes.map((b) => b.y1)), x2: Math.max(...boxes.map((b) => b.x2)), y2: Math.max(...boxes.map((b) => b.y2)) };
    const later = pieces.filter((piece) => cueOf(piece) > index);
    const desired = Math.min(to + LINGER_MS + LINGER_FADE, clipEnd);
    let end = desired;
    for (const t of exportFrameTimes(to - 140, desired, fps)) {
      if (later.some((piece) => {
        const at = pieceBounds(piece, t, input.measure);
        return at !== null && meets(at, box);
      })) {
        end = t;
        break;
      }
    }
    if (end >= to + 100) out.set(index, end);
  }
  return out;
}

export const chronicleProgram: SceneProgram = {
  build(input) {
    if (input.cues.length === 0 || input.cues.every((cue) => cue.words.length === 0)) return { pieces: [] };
    const geo = geometry(input);
    const first = chronicleCaptions(input, geo, new Map());
    const linger = lingers(first, input);
    const captions = linger.size > 0 ? chronicleCaptions(input, geo, linger) : first;
    return { pieces: [...timeline(input, geo), ...captions] };
  },
};
