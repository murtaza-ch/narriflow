import type { DemoScript } from "../demo";
import { EASES, clamp, lerp, prog } from "../ease";
import { paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast } from "@narriflow/validators";
import type { SceneCue } from "../input";
import { balancedRows, cueDirection, rowVisualOrder, rowWidth } from "../layout";
import type { Frames, PathCmd, Piece, Track } from "../scene";
import { ellipsePath, polylinePath, roundedRectPath } from "../shapes";
import { galleryScene } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Bento (`samples/templates/m61-bento.js`): each cue is a tight grid of rounded cards (12 px gaps, a calm paper-and-ink palette,
 * like a 2025 product page). A card pops in with a small spring the moment its first word is spoken and holds only the words said
 * so far, widening as each next word is spoken; the key word owns the biggest card, in the accent colour, with a small arrow chip
 * on its corner. The grid re-centres on the cards shown so far, so the first card sits mid-frame and the camera eases outward as
 * the grid fills. Cards leave in a quick staggered shrink. Plus Jakarta Sans, 700 on body words and 800 on the key word.
 *
 * What changed from the sample, and why (gallery-5 brief, 2026-11-25; review fixes 2026-11-26):
 * - Cards come from the words, not from `LAYOUTS[ci]`. A key word owns a card; the words around it are cut into cards that each
 *   close after a body word (so "most people" and "right before it" read as the sample's) and never hold more than three words.
 *   Type size follows the card's role (key word 172, body 112 or 100 alternating, minor-only 72: the sample's 150 / 92-104 / 62-78 at
 *   its 1.15 em scale). Cards are packed into rows evenly (`balancedRows`) and a card hugs its own text.
 * - The grid is the sample's 900 px, but it adapts to the space: a row that one more card would overfill squeezes its type together
 *   (down to 0.75, as the sample's own "scale the row down" does) instead of pushing that card onto a row of its own, so compact cues
 *   keep the sample's two-row look. A card too wide for the grid is split into more cards; a single word too wide is shrunk to no less
 *   than 72 % and then broken into stacked lines inside its own card (on grapheme clusters, so an accent stays on its letter; Latin,
 *   Cyrillic and Greek words only, other scripts shrink to the grid and are never cut apart). Stacked lines are spaced by their
 *   measured ink, so a descender never meets the accent on the line below.
 * - A stack too tall for its lane (2x size, tall scripts, two speakers on 16:9) first uses the whole lane width, then looks for the
 *   largest size that fits with room left for the focus ring and the entrance and exit offsets. Speakers who overlap take the smaller
 *   of their fits, so they read alike and neither lane grows into the other.
 * - A card's height comes from the measured ink as well as the sample's 1.42 em, so Devanagari and Urdu ink never leaves its card,
 *   and the baseline sits where the sample's line box puts it (0.408 em under the card centre for this face). The card has widened to
 *   back each word before the word first paints, and a word rises into place no further than its card has room.
 * - The card's growth is a rounded clip over the full card, so the corners stay round as it widens; its soft shadow is a separate
 *   blurred piece that widens with it (a clipped shadow would be cut flat). Growth steps shorter than two painted frames are static.
 * - Colour: tones cycle by cue and card, never by cue index alone, and neighbouring cards always differ. Ink is the sample's dark or
 *   white unless that fails the shared 3:1 brand guard (`CAPTION_SCENE_BRAND_MIN_CONTRAST`), then whichever of the two reads better.
 *   Brand colours: the ivory card takes the primary, the key word's card the highlight; sage, sky, sand and the ink card keep
 *   their own calm paper tones.
 * - Real speech: a card first paints at most 60 ms before its first word and its pop is compressed into the word's own time when
 *   the word is short; the exit starts no earlier than 150 ms after the last spoken end and is dropped for a cut when fewer than
 *   two painted frames remain. A cue whose window paints on a single frame keeps its tile (named as a part of its first word, so the
 *   shared one-frame filter leaves it), so no word is ever bare. Right-to-left cues mirror the row order, the growth edge and the
 *   corners the decorations use.
 * - New recurring beats, in the product-page language, on every cue: a white focus RING pulses out from the key card (the last
 *   card when there is no key word) as it lands, and small round BADGES (dot, plus, check, cycling by cue) pin to the leading top
 *   corner of every second other card (a one-card cue pins one to its key card). Both sit under or beside the type and clear of
 *   every word; the sample's arrow chip stays on the key word's card.
 * - Cost: one blurred shadow per card; no other blur.
 */

export const BENTO_DEMO: DemoScript = {
  lines: [
    "stop:b scrolling:b start:b building:h@620",
    "most:m people:b quit:b right:m before:m it:m works:h@600",
    "just:m keep:b going:b",
    "small:b habits:b big:b results:h@620",
    "that's:m the:m whole:b secret:h@620",
  ],
  options: { rate: 255, cueGap: 150, tail: 800, lead: 380 },
};

const FACE_BODY = "Plus Jakarta Sans Bold" as const;
const FACE_HERO = "Plus Jakarta Sans ExtraBold" as const;
const SPACING = -0.025;
const ANCHOR = 1290;
const GRID = 900;
const GAP = 12;
const RADIUS = 38;
const WORD_GAP = 0.26;
const PAD_X = 0.34;
const PAD_Y = 0.2;
const HERO = 172;
const BODY = [112, 100] as const;
const MINOR = 72;
/** A word that cannot fit its card at this share of its size is broken into lines instead of shrunk further. */
const SHRINK_FLOOR = 0.72;
/** Plus Jakarta Sans puts its baseline this far under the middle of a line box (hhea ascent 1.038, descent 0.222). */
const BASELINE_BELOW_CENTRE = 0.408;
const POP_LEAD = 60;
const WORD_LEAD = 30;
const GROW_LEAD = 110;
const CAMERA_MS = 300;
const DARK = "#17181C";
const WHITE = "#FFFFFF";
const SAGE = { bg: "#CBDCCB", fg: "#14241A" };
const SKY = { bg: "#D2DFF1", fg: "#112340" };
const SAND = { bg: "#E7D6BC", fg: "#2B1D0B" };

/** The sample's ink for the fill when it passes the shared brand guard (3:1), else whichever of dark and white reads better. */
const inkOn = (fill: string, preferred: string = DARK) =>
  captionColourContrast(fill, preferred) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? preferred : captionColourContrast(fill, WHITE) >= captionColourContrast(fill, DARK) ? WHITE : DARK;

/** Scripts whose words may be cut into lines: letters that stand alone. Joined and syllabic scripts are never cut. */
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{M}]+$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Rows may squeeze their type by at most this to hold one more card (the sample scales a wide row down together). */
const SQUEEZE = 0.75;

interface Seg {
  /** The spoken word this text belongs to; a broken word has several segments with the same `at`. */
  readonly at: number;
  readonly text: string;
  readonly part: number | null;
  readonly width: number;
  readonly inkTop: number;
  readonly inkBottom: number;
  /** Centre of the text, px from the card's centre. */
  readonly cx: number;
  /** Baseline, px from the card's centre. */
  readonly baseline: number;
}

interface Card {
  readonly ids: readonly number[];
  readonly hero: boolean;
  readonly size: number;
  readonly segs: readonly Seg[];
  readonly width: number;
  readonly height: number;
  /** Fitted down or broken for a long word: never squeezed with its row. */
  readonly fixed: boolean;
  /** Canvas centre of the card before the camera moves. */
  cx: number;
  cy: number;
}

/** The small glyph in a badge, on a 100 grid centred on the origin. */
function badgePaths(kind: number, r: number): { path: readonly PathCmd[]; stroke?: number; fill?: boolean }[] {
  const k = r / 100;
  switch (kind % 3) {
    case 0: return [{ path: ellipsePath(0, 0, 38 * k), fill: true }];
    case 1: return [{ path: polylinePath([[-36 * k, 0], [36 * k, 0]]), stroke: 22 * k }, { path: polylinePath([[0, -36 * k], [0, 36 * k]]), stroke: 22 * k }];
    default: return [{ path: polylinePath([[-38 * k, 2 * k], [-12 * k, 28 * k], [38 * k, -26 * k]]), stroke: 22 * k }];
  }
}

export const bentoProgram = galleryScene("bento", ANCHOR, (ctx) => {
  const { cue, index, to } = ctx.window;
  const { input, space, side, exit, exitAt } = ctx;
  const c = input.colours;
  const safeH = space.safe.y2 - space.safe.y1;

  /** A cue's layout: its cards laid out at `u` px per sample px (packed rows, centred, with the total height). */
  const layoutOf = (target: SceneCue, targetIndex: number) => {
    const direction = cueDirection(target);
    const texts = target.words.map((word) => word.text);
    return (u: number, wide: boolean) => {
      const gap = GAP * u;
      // The grid leaves room each side for the focus ring and the chip, which reach past the cards. `wide` lets it use the whole lane.
      const laneW = space.safe.x2 - space.safe.x1 - 100 * u;
      const gridMax = wide ? laneW : Math.min(GRID * u, laneW);
      const measure = (text: string, face: typeof FACE_BODY | typeof FACE_HERO, size: number) => input.measure(text, face, size, SPACING);

      // ---- cards: a key word alone, the words around it closing after each body word -------------------------------------------
      const groups: number[][] = [];
      let open: number[] = [];
      const close = () => {
        if (open.length > 0) groups.push(open);
        open = [];
      };
      target.words.forEach((word, at) => {
        if (word.role === "hero") {
          close();
          groups.push([at]);
          return;
        }
        open.push(at);
        if (word.role === "body" || open.length === 3) close();
      });
      close();

      let bodyCards = 0;
      const sizeOf = (ids: readonly number[]) => {
        if (ids.some((at) => target.words[at]!.role === "hero")) return HERO;
        if (ids.some((at) => target.words[at]!.role === "body")) return BODY[(targetIndex + bodyCards++) % BODY.length]!;
        return MINOR;
      };

      /** One card for `ids` at nominal `nominal` px, or several when the words do not fit the grid; a lone long word is broken. */
      const plan = (ids: readonly number[], hero: boolean, nominal: number): Card[] => {
        const face = hero ? FACE_HERO : FACE_BODY;
        const natural = (size: number) => {
          const advances = ids.map((at) => measure(texts[at]!, face, size).advance);
          return { advances, text: advances.reduce((sum, w) => sum + w, 0) + WORD_GAP * size * (ids.length - 1) };
        };
        const first = natural(nominal);
        if (first.text + 2 * PAD_X * nominal <= gridMax) return [singleLine(ids, hero, nominal, face)];
        if (ids.length > 1) {
          let k = 1;
          while (k < ids.length - 1 && natural(nominal).advances.slice(0, k + 1).reduce((s, w) => s + w, 0) + WORD_GAP * nominal * k + 2 * PAD_X * nominal <= gridMax) k++;
          return [...plan(ids.slice(0, k), hero, nominal), ...plan(ids.slice(k), hero, nominal)];
        }
        const at = ids[0]!;
        const word = texts[at]!;
        const fit = gridMax / (first.text + 2 * PAD_X * nominal);
        if (fit >= SHRINK_FLOOR || !SPLITTABLE.test(word)) return [singleLine(ids, hero, nominal * fit, face, true)];
        const letters = [...graphemes.segment(word)].map((part) => part.segment);
        for (let lines = 2; lines <= 8; lines++) {
          const chunks = Array.from({ length: lines }, (_, k) => letters.slice(Math.round((k * letters.length) / lines), Math.round(((k + 1) * letters.length) / lines)).join(""));
          const widest = Math.max(...chunks.map((chunk) => measure(chunk, face, nominal).advance));
          const f = Math.min(1, gridMax / (widest + 2 * PAD_X * nominal));
          if (f >= SHRINK_FLOOR || lines === 8) return [stacked(at, hero, nominal * f, face, chunks)];
        }
        return [singleLine(ids, hero, nominal * fit, face, true)];
      };

      const singleLine = (ids: readonly number[], hero: boolean, size: number, face: typeof FACE_BODY | typeof FACE_HERO, fixed = false): Card => {
        const ms = ids.map((at) => measure(texts[at]!, face, size));
        const wordGap = WORD_GAP * size;
        const textW = ms.reduce((sum, m) => sum + m.advance, 0) + wordGap * (ids.length - 1);
        const width = textW + 2 * PAD_X * size;
        const inkTop = Math.min(...ms.map((m) => m.inkTop));
        const inkBottom = Math.max(...ms.map((m) => m.inkBottom));
        const height = Math.max(size * (1.02 + 2 * PAD_Y), inkBottom - inkTop + 0.26 * size);
        const baseline = Math.min(Math.max(BASELINE_BELOW_CENTRE * size, -height / 2 + 0.13 * size - inkTop), height / 2 - 0.13 * size - inkBottom);
        let x = -textW / 2;
        const segs: Seg[] = [];
        for (const k of rowVisualOrder(ids.map((at) => texts[at]!), direction)) {
          const m = ms[k]!;
          segs.push({ at: ids[k]!, text: texts[ids[k]!]!, part: null, width: m.advance, inkTop: m.inkTop, inkBottom: m.inkBottom, cx: x + m.advance / 2, baseline });
          x += m.advance + wordGap;
        }
        return { ids, hero, size, segs, width, height, fixed, cx: 0, cy: 0 };
      };

      const stacked = (at: number, hero: boolean, size: number, face: typeof FACE_BODY | typeof FACE_HERO, chunks: readonly string[]): Card => {
        const ms = chunks.map((chunk) => measure(chunk, face, size));
        // Lines are spaced by their measured ink (a descender above an acute accent needs more than one em), never by a fixed leading.
        const inkTop = Math.min(...ms.map((m) => m.inkTop));
        const inkBottom = Math.max(...ms.map((m) => m.inkBottom));
        const lineH = Math.max(size * 0.9, inkBottom - inkTop + 0.06 * size);
        const height = chunks.length * lineH + 2 * PAD_Y * size;
        const width = Math.max(...ms.map((m) => m.advance)) + 2 * PAD_X * size;
        const segs = chunks.map((text, part): Seg => ({
          at, text, part, width: ms[part]!.advance, inkTop: ms[part]!.inkTop, inkBottom: ms[part]!.inkBottom, cx: 0,
          baseline: -height / 2 + PAD_Y * size + part * lineH + 0.03 * size - inkTop,
        }));
        return { ids: [at], hero, size, segs, width, height, fixed: true, cx: 0, cy: 0 };
      };

      const cards = groups.flatMap((ids) => {
        const hero = target.words[ids[0]!]!.role === "hero";
        return plan(ids, hero, sizeOf(ids) * u);
      });

      // ---- rows: cards packed evenly, each row centred, cards centred in their row -------------------------------------------------
      // A row that one more card would overfill may squeeze its type together (down to SQUEEZE, as the sample does) rather than
      // push that card onto a row of its own, so a short cue keeps the sample's two-row grid. Cards fitted down for a long word keep their size.
      const widths = cards.map((card) => card.width);
      /** The factor the type of `row` needs to fit the grid (1 when it fits), or 0 when it cannot be squeezed. */
      const squeezeOf = (row: readonly number[]) => {
        if (rowWidth(widths, row, gap) <= gridMax) return 1;
        if (row.some((k) => cards[k]!.fixed)) return 0;
        const f = (gridMax - gap * (row.length - 1)) / row.reduce((sum, k) => sum + widths[k]!, 0);
        return f >= SQUEEZE ? f : 0;
      };
      let rows = balancedRows(widths, gap, gridMax);
      if (rows.length > 1) {
        const dense = balancedRows(widths, gap, gridMax / SQUEEZE);
        if (dense.length < rows.length && dense.every((row) => squeezeOf(row) > 0)) rows = dense;
      }
      for (const row of rows) {
        const f = squeezeOf(row);
        if (f >= 1 || f === 0) continue;
        for (const k of row) {
          const card = cards[k]!;
          cards[k] = singleLine(card.ids, card.hero, card.size * f, card.hero ? FACE_HERO : FACE_BODY);
        }
      }
      const rowH = rows.map((row) => Math.max(...row.map((k) => cards[k]!.height)));
      const total = rowH.reduce((sum, h) => sum + h, 0) + gap * (rows.length - 1);
      let top = space.y(ANCHOR) - total / 2;
      const centreX = space.x(540);
      rows.forEach((row, r) => {
        const rowW = row.reduce((sum, k) => sum + cards[k]!.width, 0) + gap * (row.length - 1);
        let x = centreX - rowW / 2;
        const order = rowVisualOrder(row.map((k) => cards[k]!.ids.map((at) => texts[at]!).join(" ")), direction);
        for (const slot of order) {
          const card = cards[row[slot]!]!;
          card.cx = x + card.width / 2;
          card.cy = top + rowH[r]! / 2;
          x += card.width + gap;
        }
        top += rowH[r]! + gap;
      });
      return { cards, total, gap };
    };
  };

  // The stack must leave room above and below for the focus ring, the entrance rise and the exit drop.
  const reach = (u: number) => 76 * u;
  type Layout = ReturnType<ReturnType<typeof layoutOf>>;
  const fits = (laid: Layout, u: number) => laid.total + reach(u) <= safeH;
  /** The largest size of a cue that fits its lane: the lane's width is spent first (a wider grid), then the type gets smaller. */
  const fitOf = (target: SceneCue, targetIndex: number) => {
    const arrange = layoutOf(target, targetIndex);
    if (fits(arrange(space.u, false), space.u)) return { k: 1, wide: false };
    if (fits(arrange(space.u, true), space.u)) return { k: 1, wide: true };
    let lo = 0.15;
    let hi = 1;
    for (let tries = 0; tries < 9; tries++) {
      const mid = (lo + hi) / 2;
      if (fits(arrange(space.u * mid, true), space.u * mid)) lo = mid;
      else hi = mid;
    }
    return { k: lo, wide: true };
  };
  const own = fitOf(cue, index);
  // Speakers who overlap share the smaller fit, so they read alike (and neither lane outgrows its half).
  const span = (target: SceneCue) => [Math.min(...target.words.map((word) => word.startMs)), Math.max(...target.words.map((word) => word.endMs))] as const;
  const [start, end] = span(cue);
  let k = own.k;
  input.cues.forEach((other, at) => {
    if (at === index || other.words.length === 0) return;
    const [otherStart, otherEnd] = span(other);
    if (otherStart < end && start < otherEnd) k = Math.min(k, fitOf(other, at).k);
  });
  const u = space.u * k;
  const laid = layoutOf(cue, index)(u, own.wide);
  const { cards, gap } = laid;

  // ---- timing ----------------------------------------------------------------------------------------------------------------
  const cardOrder = cards.map((card, k) => ({ card, k }));
  const pops = cards.map((card) => ctx.enter(cue.words[card.ids[0]!]!, card.hero ? 430 : 330, POP_LEAD));
  const entries = cue.words.map((word) => {
    const hero = word.role === "hero";
    return { word, ...ctx.enter(word, hero ? 420 : 200, WORD_LEAD), hero };
  });
  const grows = cue.words.map((word) => ctx.enter(word, 200, GROW_LEAD));

  // The camera: the grid re-centres on the cards shown so far.
  const rect = (card: Card) => ({ x1: card.cx - card.width / 2, x2: card.cx + card.width / 2, y1: card.cy - card.height / 2, y2: card.cy + card.height / 2 });
  const union = (list: readonly ReturnType<typeof rect>[]) => ({
    x1: Math.min(...list.map((r) => r.x1)), x2: Math.max(...list.map((r) => r.x2)), y1: Math.min(...list.map((r) => r.y1)), y2: Math.max(...list.map((r) => r.y2)),
  });
  const whole = union(cards.map(rect));
  const steps = cards.map((_, k) => {
    const seen = union(cards.slice(0, k + 1).map(rect));
    return { dx: (whole.x1 + whole.x2) / 2 - (seen.x1 + seen.x2) / 2, dy: (whole.y1 + whole.y2) / 2 - (seen.y1 + seen.y2) / 2 };
  });
  const camera = (t: number): readonly [number, number] => {
    let x = steps[0]!.dx;
    let y = steps[0]!.dy;
    for (let k = 1; k < steps.length; k++) {
      const e = EASES.outExpo(prog(t, pops[k]!.from, CAMERA_MS));
      x = lerp(x, steps[k]!.dx, e);
      y = lerp(y, steps[k]!.dy, e);
    }
    return [x, y];
  };

  // Where any window of the cue starts or ends: the camera's steps move every piece; a card's own pop, growth and words are added per card.
  const edges = [exitAt, to, ...pops.flatMap((p) => [p.from, p.from + CAMERA_MS])];
  const bakeWith = (own: readonly number[]) => (fn: (t: number) => number, tolerance: number, from: number, extra: readonly number[] = []): Frames =>
    sampleFrames(fn, [...edges, ...own, ...extra], tolerance, { range: [from, to], simplify: true });

  const pieces: Piece[] = [];
  const cueHasHero = cue.words.some((word) => word.role === "hero");
  const keyCard = Math.max(0, cueHasHero ? cards.findIndex((card) => card.hero) : cards.length - 1);
  const counter = index * 3;
  // Every second card besides the key card wears a badge (at least one when there is another card): each badge is an animated piece or two on screen.
  const others = cards.map((_, k) => k).filter((k) => k !== keyCard);
  const badged = new Set(others.filter((_, j) => (j + index) % 2 === 0));
  if (badged.size === 0 && others.length > 0) badged.add(others[0]!);
  const tones = [
    { bg: c.primary, fg: inkOn(c.primary) },
    { bg: c.accent, fg: inkOn(c.accent, WHITE) },
    SAGE,
    SKY,
    SAND,
  ];

  cardOrder.forEach(({ card, k }) => {
    const pop = pops[k]!;
    const bake = bakeWith([pops[k]!.settled, ...card.ids.flatMap((at) => [entries[at]!.from, entries[at]!.settled, grows[at]!.from, grows[at]!.settled])]);
    const popDur = pop.motion ? pop.settled - pop.from : 0;
    const pe = (t: number) => (popDur > 0 ? prog(t, pop.from, popDur) : 1);
    const stagger = Math.min(k * 22, Math.max(0, to - exitAt - 67));
    const out = (t: number) => (exit ? EASES.in(prog(t, exitAt + stagger, to - exitAt - stagger)) : 0);
    const spring = (t: number) => (card.hero ? EASES.spring(pe(t)) : EASES.outBack(pe(t)));
    // The spring's overshoot is held to what the 12 px gap can take (a big card would otherwise grow into its neighbours).
    const overshoot = 1 + (2 * (GAP - 4) * u) / Math.max(card.width, card.height);
    const scale = (t: number) => Math.max(0.0001, Math.min(overshoot, lerp(0.55, 1, spring(t)))) * (1 - 0.1 * out(t));
    const alpha = (t: number) => lerp(0.35, 1, clamp(pe(t) * 4)) * (1 - out(t));
    const offX = (t: number) => (1 - EASES.outExpo(pe(t))) * (card.cx - (whole.x1 + whole.x2) / 2) * -0.06;
    const offY = (t: number) => (1 - EASES.outExpo(pe(t))) * 26 * u + out(t) * 10 * u;
    const X = (t: number) => card.cx + camera(t)[0] + offX(t);
    const Y = (t: number) => card.cy + camera(t)[1] + offY(t);
    const heroTone = { bg: c.highlight, fg: inkOn(c.highlight, WHITE) };
    const tone = card.hero ? heroTone : tones[(counter + k * 3) % tones.length]!;
    const from = pop.from;

    // Growth: the card hugs the words said so far.
    const shown = card.ids.map((_, step) => card.ids.slice(0, step + 1));
    const span = (ids: readonly number[]) => {
      const mine = card.segs.filter((seg) => ids.includes(seg.at));
      const pad = PAD_X * card.size;
      return [Math.max(-card.width / 2, Math.min(...mine.map((s) => s.cx - s.width / 2)) - pad), Math.min(card.width / 2, Math.max(...mine.map((s) => s.cx + s.width / 2)) + pad)] as const;
    };
    const spans = shown.map(span);
    const growth = (t: number): readonly [number, number] => {
      let l = spans[0]![0];
      let r = spans[0]![1];
      for (let step = 1; step < spans.length; step++) {
        // The tile has widened to back the word by the time the word first paints (never after).
        const g = grows[card.ids[step]!]!;
        const done = Math.min(g.settled, entries[card.ids[step]!]!.from);
        const e = paintedFrameCount(g.from, done, ctx.fps) >= 2 ? EASES.outExpo(prog(t, g.from, done - g.from)) : t >= g.from ? 1 : 0;
        l = lerp(l, spans[step]![0], e);
        r = lerp(r, spans[step]![1], e);
      }
      return [l, r];
    };
    const radius = Math.min(RADIUS * u, card.height * 0.34);
    const s = bake(scale, 0.006, from);
    const base: Track = { x: bake(X, 0.25, from), y: bake(Y, 0.25, from), sx: s, sy: s, o: bake(alpha, 0.01, from) };
    const clip = {
      x1: bake((t) => growth(t)[0], 0.15, from), x2: bake((t) => growth(t)[1], 0.15, from),
      y1: [[from, -card.height / 2]] as Frames, y2: [[from, card.height / 2]] as Frames, radius,
    };
    // A cue whose window paints on one frame (back-to-back 70 ms cues) keeps its tile as a part of its first word (`w<word>l<80+card>`,
    // whole, no clip), the one name the shared one-frame filter leaves: it paints with the word and goes with it, never under the next
    // cue's words, and the word is not bare. No shadow then.
    if (paintedFrameCount(from, to, ctx.fps) < 2) {
      pieces.push({ ...ctx.rect(`w${card.ids[0]}l${80 + k}`, from, card.cx, card.cy, card.width, card.height, radius, tone.bg, base), z: 3 });
    } else pieces.push({ ...ctx.rect(`card${k}`, from, card.cx, card.cy, card.width, card.height, radius, tone.bg, base), clip, z: 3 });
    // The soft shadow widens with the card (a shadow under a clip would be cut off at the card's edge).
    const shadowTrack: Track = {
      x: bake((t) => X(t) + ((growth(t)[0] + growth(t)[1]) / 2) * scale(t), 0.15, from),
      y: bake((t) => Y(t) + 12 * u * scale(t), 0.15, from),
      sx: bake((t) => ((growth(t)[1] - growth(t)[0]) / card.width) * scale(t), 0.003, from), sy: s, o: base.o, blur: [[from, 5 * u]],
    };
    pieces.push({ ...ctx.rect(`shadow${k}`, from, card.cx, card.cy, card.width, card.height, radius, c.shadow, shadowTrack), fill: { colour: c.shadow, alpha: 0.34 }, z: 2 });

    // The words.
    for (const seg of card.segs) {
      const entry = entries[seg.at]!;
      const dur = entry.motion ? entry.settled - entry.from : 0;
      const wp = (t: number) => (dur > 0 ? prog(t, entry.from, dur) : 1);
      // The word rises into place, but never further than the tile has room below its ink, so it is backed on every frame.
      const room = Math.max(0, card.height / 2 - (seg.baseline + seg.inkBottom) - 1.5 * u);
      const rise = Math.min(22 * u, room);
      const lift = (t: number) => (1 - EASES.outExpo(wp(t))) * rise;
      const wordScale = (t: number) => (entry.hero ? lerp(0.86, 1, EASES.spring(wp(t))) : 1);
      const ink = (seg.inkTop + seg.inkBottom) / 2;
      const start = Math.max(from, entry.from);
      const wedges = [entry.from, entry.settled];
      const wordGrow = bake((t) => scale(t) * wordScale(t), 0.006, start, wedges);
      const track: Track = {
        x: bake((t) => X(t) + seg.cx * scale(t), 0.25, start, wedges),
        y: bake((t) => Y(t) + (seg.baseline + ink) * scale(t) + lift(t) * scale(t), 0.25, start, wedges),
        sx: wordGrow,
        sy: wordGrow,
        o: bake((t) => lerp(0.3, 1, clamp(wp(t) * 3)) * alpha(t), 0.01, start, wedges),
      };
      const cell: SpeechCell = { at: seg.at, text: seg.text, face: card.hero ? FACE_HERO : FACE_BODY, size: card.size, spacing: SPACING, x: card.cx + seg.cx, baseline: card.cy + seg.baseline, width: seg.width, inkTop: seg.inkTop, inkBottom: seg.inkBottom };
      const face = ctx.face(cell, start, tone.fg, track);
      pieces.push({ ...face, id: seg.part === null ? face.id : `${face.id}l${seg.part}`, z: 6, origin: { dx: 0, dy: ink } });
    }

    // The sample's arrow chip on the key word's card, once.
    if (card.hero && k === keyCard) {
      // On fast speech the cue is gone soon after the key word: start earlier (and spin shorter) so it still paints on several frames.
      const onset = Math.max(from, Math.min(cue.words[card.ids[0]!]!.startMs + 60, to - 100));
      const chipMs = Math.min(420, Math.max(67, (to - onset) * 0.75));
      // The chip sits on the card's right edge; it is no wider than the card's padding allows, even while it spins (a square turned
      // 45 degrees reaches 1.45 times its radius, and the spring overshoots by about 10 %), so on a card whose text was fitted down it shrinks rather than touch a letter.
      const chipR = Math.min(Math.max(60 * u, card.size * 0.4) / 2, Math.max(16 * u, (PAD_X * card.size) / 1.7));
      const cs = chipR * 2;
      // Its turned box never rises past the 12 px gap into the row above.
      const local: [number, number] = [side * (card.width / 2), -card.height / 2 + Math.max(14 * u, 1.6 * chipR - gap + 2 * u)];
      const q = (t: number) => EASES.spring(prog(t, onset, chipMs));
      const chipEdges = [onset, onset + chipMs, onset + chipMs / 6];
      const t0 = bake((t) => X(t) + local[0] * scale(t), 0.15, onset, chipEdges);
      const t1 = bake((t) => Y(t) + local[1] * scale(t), 0.15, onset, chipEdges);
      const cScale = bake((t) => Math.max(0.0001, q(t)) * scale(t), 0.003, onset, chipEdges);
      const cTurn = bake((t) => (1 - EASES.out(prog(t, onset, chipMs))) * -80 * side, 0.15, onset, chipEdges);
      const cAlpha = bake((t) => clamp(prog(t, onset, chipMs) * 6) * (1 - out(t)), 0.004, onset, chipEdges);
      const chip: Track = { x: t0, y: t1, sx: cScale, sy: cScale, rz: cTurn, o: cAlpha };
      pieces.push({ ...ctx.dot(`chip${card.ids[0]}`, onset, card.cx, card.cy, cs / 2, WHITE, chip), z: 9 });
      const arrow = (cs / 64) * 1;
      pieces.push({
        ...ctx.shape(`chiparrow${card.ids[0]}`, onset, polylinePath([[-10 * arrow, 10 * arrow], [10 * arrow, -10 * arrow], [-5 * arrow, -10 * arrow], [10 * arrow, -10 * arrow], [10 * arrow, 5 * arrow]]), chip),
        z: 10, stroke: { widthPx: 5 * arrow, colour: c.highlight },
      });
    }

    // Extra beat 2: a round badge pinned to the leading top corner; dot, plus and check take turns by cue.
    const addBadge = () => {
      const kind = index + 2 * k + Math.floor(index / 3);
      const r = clamp(card.size * 0.26, 14 * u, 22 * u);
      const onset = Math.max(from, Math.min(cue.words[card.ids[0]!]!.startMs + 120, to - 100));
      const badgeMs = Math.min(340, Math.max(67, (to - onset) * 0.75));
      const local: [number, number] = [-side * (card.width / 2 - 2 * u), -card.height / 2 + 2 * u];
      const bp = (t: number) => EASES.spring(prog(t, onset, badgeMs));
      const bEdges = [onset, onset + badgeMs, onset + badgeMs / 6];
      const bx = bake((t) => X(t) + local[0] * scale(t), 0.15, onset, bEdges);
      const by = bake((t) => Y(t) + local[1] * scale(t), 0.15, onset, bEdges);
      const bs = bake((t) => Math.max(0.0001, bp(t)) * scale(t), 0.003, onset, bEdges);
      const bo = bake((t) => clamp(prog(t, onset, badgeMs) * 6) * (1 - out(t)), 0.004, onset, bEdges);
      const track: Track = { x: bx, y: by, sx: bs, sy: bs, o: bo };
      const owner = card.ids[0]!;
      // The dot is one piece (accent with a white ring); plus and check sit on a white disc.
      const plain = kind % 3 === 0;
      pieces.push({ ...ctx.dot(`badge${owner}`, onset, card.cx, card.cy, plain ? r * 0.8 : r, plain ? c.highlight : WHITE, track), z: 9, ...(plain ? { stroke: { widthPx: r * 0.3, colour: WHITE } } : {}) });
      if (plain) return;
      badgePaths(kind, r).forEach((part, g) => {
        const piece = ctx.shape(`badgeglyph${owner}-${g}`, onset, part.path, track);
        pieces.push(part.fill ? { ...piece, z: 10, fill: { colour: c.highlight } } : { ...piece, z: 10, stroke: { widthPx: part.stroke!, colour: c.highlight } });
      });
    
    };

    // Extra beat 1: a white focus ring pulses out from the key card as it lands.
    if (k === keyCard) {
      const onset = Math.max(from, cue.words[card.ids[0]!]!.startMs);
      const length = Math.min(440, to - onset);
      const grow = 28 * u;
      const rp = (t: number) => prog(t, onset, length);
      const ringEdges = [onset, onset + length];
      const ringBase = 8 * u;
      const rw = card.width + 2 * ringBase;
      const rh = card.height + 2 * ringBase;
      const ringTrack: Track = {
        x: bake((t) => X(t), 0.15, onset, ringEdges), y: bake((t) => Y(t), 0.15, onset, ringEdges),
        sx: bake((t) => scale(t) * lerp(1, (rw + 2 * grow) / rw, EASES.outExpo(rp(t))), 0.003, onset, ringEdges),
        sy: bake((t) => scale(t) * lerp(1, (rh + 2 * grow) / rh, EASES.outExpo(rp(t))), 0.003, onset, ringEdges),
        o: bake((t) => 0.9 * (1 - EASES.out(rp(t))) * alpha(t), 0.004, onset, ringEdges),
      };
      if (length >= 67) {
        pieces.push({ ...ctx.shape(`ring${card.ids[0]}`, onset, roundedRectPath(-rw / 2, -rh / 2, rw, rh, radius + ringBase), ringTrack), z: 4, toMs: onset + length, stroke: { widthPx: 5 * u, colour: c.primary } });
      }
      // A cue with no other card gives its key card the badge as well, so every cue has a second beat.
      if (others.length === 0) addBadge();
    } else if (badged.has(k)) {
      addBadge();
    }
  });

  return pieces;
});
