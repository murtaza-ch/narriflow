import { toCaptionUpperCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, lerp, prog } from "../ease";
import { SCENE_DEFAULT_FPS, exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes, sceneSampleRate } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, rowsFromRoles, sceneSpace } from "../layout";
import { type Box, type Clip, type Measure, type Piece, type ShapePiece, type TextPiece, type Track, evaluatePiece, pieceBounds, pieceLocalBox } from "../scene";
import { polygonPath, rectPath } from "../shapes";

/**
 * Cascade (`samples/templates/m20-mechanica.js`, the sample's "Mechanica"): a machine-precise caption system in heavy wide caps.
 * Ordinary words are italic lockups (Archivo Black 84 px, sheared -12 degrees, the whole block tipped -6 degrees, each row stepped
 * in 46 px) riding a thin white rule; every word cuts in with a red / cyan split that snaps to white in 150 ms. The hero word
 * punches in upright, fitted to 600 px, blur to sharp, and fires an echo cascade: outline copies above and below it flash on a
 * 150 ms beat (stack, gone, stack, staircase), and a level rule draws in under it. The block leaves
 * with a left-to-right wipe.
 *
 * What changed from the sample, and why (gallery-3 brief, 2026-11-21):
 * - `LEFT 170` is gone: the block (rule and the slow drift included) is centred on the anchor; a right-to-left cue is the
 *   mirror image (tilt, shear, indent, drift and wipe all flip, rows are flush right).
 * - The rule ran x 20 -> 980 (outside the safe margin) and the 46 px indent pushed a third row to the edge: the rule now spans the
 *   block, the row limit shrinks with the number of rows, and a block that still does not fit shrinks as
 *   a whole. Lockup words had no fit: a word wider than a row shrinks the block (no floor, a word must fit).
 * - The sample's hero cue drew only the hero and silently dropped every other word of the cue. Now the words before and after the
 *   hero are lockup rows (italic, straight, centred) above and below it, and a cue's hero run of several words is one hero row.
 *   Echo copies only go where no row is: a row above means no copies above; with rows on both sides the cascade becomes a
 *   horizontal trail.
 * - `PATTERN` was the same on every hero cue: four beat patterns now cycle by a counter of hero cues. The cascade needs ~1.3 s;
 *   it is compressed to the time the hero has (beat 100 to 150 ms, leading silent beats dropped, the rule drawn in what is left).
 * - Recurring extras in the template's own language (counted per cue by the tests): on every lockup cue a scan bar that sweeps each word as it splits
 *   (three variants), and a rule that is drawn in red / cyan before it settles white; on every hero cue register brackets that close
 *   in on the hero (three variants), the same red / cyan rule, and a rule that draws left, right or from the middle.
 * - Real speech: the sample's 160 ms wipe covered the last 180 ms of speech. The exit never starts before the last word has been
 *   fully visible for 150 ms, shortens (down to 90 ms) when the next cue is close and runs at most 60 ms into it. The slow drift is
 *   the sample's 0.018 px/ms, stopped after 1.7 s so it never leaves the safe area on a long hold.
 *   Handoffs use the shared export grid at the render's actual frame rate. Overlapping speakers get lanes clear of live echoes;
 *   trimming a decoration leaves the word's lead intact, and the hero includes the preceding frame even at 24 fps.
 * - Arrow decorations are omitted from both hero and lockup cues at the owner's request.
 * - The hero punch blur (14 px for 170 ms) is kept (two frames of it at 30 fps are visible); the rule's `0 2px 8px` shadow is
 *   dropped (invisible on the dark footage the template is judged on); the words' shadow is one soft layer.
 * - The tilted wipe edge is the sample's local vertical, a canvas clip per word at that word's row (it leans 6 degrees in the sample).
 * - Words in scripts that need shaping and CJK are never split into letters (this template never splits letters); capitals only for
 *   Latin, Greek and Cyrillic. Splits use the brand colours' highlight and accent slots (red and cyan by default).
 */

export const CASCADE_DEMO: DemoScript = {
  lines: [
    "you:m don't:b need:b more:b time",
    "you:m need:b",
    "FOCUS:h@620",
    "cut:b+520 the:m noise:b and",
    "SHIP:h@620",
  ],
  options: { rate: 265, cueGap: 200, tail: 900 },
};

const FACE = "Archivo Black" as const;
const LS = 0.005;
const BODY = 84;
const HERO_MAX = 128;
const HERO_FIT = 600;
const TILT = -6;
const SHEAR = -12;
const WRAP = 700;
const INDENT = 46;
const CENTER_Y = 1290;
const LINE_EM = 1.02;
const SPLIT_PX = 14;
const SPLIT_MS = 150;
const WORD_LEAD = 50;
/** The least an animated entrance, exit or decoration lasts at 30 fps: two export frames (handoff rule 4); `minAnimOf` gives it for the render's rate. */
const MIN_ANIM = 67;
const minAnimOf = (fps: number) => Math.ceil(2000 / sceneSampleRate(fps));
const FADE_MS = 67;
const RULE_LEAD = 80;
/** Clip edges that stay open: far enough that the safe-area shift cannot bring them into view. */
const OPEN_EDGE = 20000;
const HERO_LEAD = 40;
const HERO_PUNCH = 170;
const STROKE = 3.2;
const ECHO_PITCH = 0.78;
const DRIFT_PX = 30;
const DRIFT_MS = 1700;
const LEFT_REACH = 128;
const RULE_OVER = 60;
const RULE_THICK = 4;
const RULE_SEG = 170;
const EXIT = 160;
const HOLD = 150;

/** Archivo Black's line box: ascent 0.878 and descent 0.21 em, each rounded to whole px by Chrome. */
export function cascadeBaseline(sizePx: number): number {
  const ascent = Math.round(0.878 * sizePx);
  const descent = Math.round(0.21 * sizePx);
  return (sizePx - (ascent + descent)) / 2 + ascent;
}

/** FNV-1a: the seed that makes a cue's jitter a pure function of its index and words. */
export function cascadeHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SIMPLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;

/** `text-transform: uppercase` through the shared caption casing (Turkish dotted İ, Greek, caseless scripts left alone). */
export function cascadeCase(text: string, language?: string | null): string {
  return toCaptionUpperCase(text, language);
}

/** The faux italic (a shear) belongs to cased Latin, Greek and Cyrillic: a shaped script (Arabic, Indic, Thai) or CJK is never sheared. */
export function cascadeShears(text: string): boolean {
  return SIMPLE.test(text) && !PICTO.test(text);
}

export type CascadeMode = "none" | "stack" | "stair" | "stair2";

/** The echo beat patterns, cycled by hero cue. The first is the sample's. */
export const CASCADE_PATTERNS: readonly (readonly CascadeMode[])[] = [
  ["none", "stack", "none", "stack", "stair", "stair2"],
  ["none", "stair", "none", "stair2", "stack", "stack"],
  ["stack", "none", "stair2", "none", "stair", "stack"],
  ["none", "stack", "stair2", "stair", "none", "stack"],
];

/** How a hero cue spends the time `avail` ms it has between its first word and its exit: the beat, the modes used and the rule's window. */
export function cascadeBeats(avail: number, minAnim = MIN_ANIM): { beat: number; steps: number; ruleDur: number } {
  const ruleDur = clamp(avail * 0.3, minAnim, 420);
  const modeTime = Math.max(0, avail - ruleDur);
  const steps = clamp(Math.floor(modeTime / 100), 1, 6);
  const beat = clamp(modeTime / steps, minAnim, 150);
  return { beat, steps, ruleDur };
}

const frame = (at: number, value: number) => [[at, value]] as Frames;

interface Frame {
  readonly ex: number;
  readonly ey: number;
  readonly theta: number;
  readonly cos: number;
  readonly sin: number;
}

interface Row {
  readonly items: { readonly index: number; readonly lx: number; readonly w: number }[];
  readonly width: number;
  /** Row box top, canvas px relative to the frame's y. */
  readonly ly: number;
}

interface Plan {
  readonly sizeC: number;
  readonly rows: Row[];
  readonly blockW: number;
  readonly blockH: number;
  readonly lineH: number;
}

/**
 * How the cue meets the others (handoff rule, `gallery3-brief.md`): `shift` is how much of its words' entrance lead is given up
 * (never past the last export frame before the spoken start), `decor` how much of the rule's lead (all the way to the first word),
 * `limit` the first painted frame at which a later cue's piece would be drawn over this cue's words, `dy` a vertical lane when two
 * speakers need the same space at once.
 */
interface Control {
  readonly shift: number;
  readonly decor: number;
  readonly limit: number;
  readonly dy: number;
}

const FREE: Control = { shift: 0, decor: 0, limit: Number.POSITIVE_INFINITY, dy: 0 };

/** How far a cue's words may give up their lead: their first painted frame stays at or before the last frame at their spoken start. */
export function cascadeWordCap(cue: Pick<SceneCue, "words">, fps: number = SCENE_DEFAULT_FPS): number {
  const hero = rowsFromRoles(cue.words.map((word) => word.role)).hero;
  const caps = cue.words.map((word, index) => exportFrameAtOrBefore(word.startMs, fps) - 1 - (word.startMs - (hero.includes(index) ? HERO_LEAD : WORD_LEAD)));
  return Math.max(0, ...(caps.length > 0 ? [Math.min(...caps)] : [0]));
}

function buildCue(cue: SceneCue, cueNumber: number, input: SceneInput, variant: { hero: number; lockup: number }, ctl: Control = FREE): Piece[] {
  const space = sceneSpace(input, CENTER_Y);
  const { u, safe } = space;
  const direction = cueDirection(cue);
  const rtl = direction === "rtl";
  const sgn = rtl ? -1 : 1;
  const Py = space.y(CENTER_Y) + ctl.dy;
  const Cx = space.x(540);
  const band = cueNumber * 16;
  const seed = cascadeHash(`${cue.index}|${cue.words.map((word) => word.text).join(" ")}`);
  const colours = input.colours;
  const WHITE = colours.primary;
  const SPLIT_A = colours.highlight;
  const SPLIT_B = colours.accent;
  const roles = rowsFromRoles(cue.words.map((word) => word.role));
  const hasHero = roles.hero.length > 0;
  const heroNumber = hasHero ? variant.hero : 0;
  const lockupNumber = hasHero ? 0 : variant.lockup;
  const texts = cue.words.map((word) => cascadeCase(word.text, cue.language));
  const sheared = (index: number) => cascadeShears(cue.words[index]!.text);
  const adv = (text: string, sizeC: number) => input.measure(text, FACE, sizeC, LS).advance + LS * sizeC;
  const gapOf = (sizeC: number) => input.measure("A B", FACE, sizeC, LS).advance - input.measure("AB", FACE, sizeC, LS).advance;
  const baseOf = (sizeC: number) => cascadeBaseline(sizeC / u) * u;
  const safeW = safe.x2 - safe.x1;
  const safeH = safe.y2 - safe.y1;
  const startOf = (index: number) => cue.words[index]!.startMs;
  const fps = input.fps ?? SCENE_DEFAULT_FPS;
  const minAnim = minAnimOf(fps);
  const fadeMs = Math.max(FADE_MS, minAnim);

  // --- timing: entrances are locked to speech; the exit gives way to a later cue's colliding ink ---
  const wordShift = Math.min(ctl.shift, cascadeWordCap(cue, fps));
  // At 24 fps the preceding frame can be more than the hero's 40 ms lead away. Include it even when
  // the onset falls just before the next frame, rather than first painting after the word starts.
  const enter = (index: number, lead: number) => Math.min(startOf(index) - lead + wordShift, exportFrameAtOrBefore(startOf(index), fps) - 1);
  const lockupEnter = (index: number) => enter(index, WORD_LEAD);
  const heroEnter = (index: number) => enter(index, HERO_LEAD);
  // The cue leaves at its end at the latest, and never before its last word has been spoken (the shared cue end of overlapping
  // speakers can come first); a later cue's first painted ink over its words ends it sooner.
  const lastEnd = Math.max(...cue.words.map((word) => word.endMs));
  const ceiling = Math.min(ctl.limit, Math.max(cue.endMs, lastEnd));
  // The reading hold is counted from settled ink (the white face opaque, a hero's punch cleared), not from the colour split's tail.
  // Entrance effects are the last thing to give: per word, only when the hold would not fit before the ceiling.
  const holdRoom = (enter: number) => ceiling - HOLD - enter;
  const fadeOf = (index: number) => (holdRoom(lockupEnter(index)) >= fadeMs ? fadeMs : 0);
  const splitOf = (index: number) => {
    const room = ceiling - lockupEnter(index);
    return room >= SPLIT_MS ? SPLIT_MS : room >= minAnim ? Math.floor(room) : 0;
  };
  const effectOf = (enter: number, full: number) => {
    const room = holdRoom(enter);
    return room >= full ? full : room >= minAnim ? Math.floor(room) : 0;
  };
  const punchOf = (index: number) => effectOf(heroEnter(index), HERO_PUNCH);
  const lastSettle = Math.max(
    ...cue.words.map((_, index) => (roles.hero.includes(index) ? heroEnter(index) + Math.round(0.7 * punchOf(index)) : lockupEnter(index) + fadeOf(index))),
  );
  const exitTo = Math.round(ceiling);
  // The wipe starts after the last word has been spoken and held; with no room for two painted frames it is dropped (a cut).
  const wipeRoom = exitTo - Math.max(lastSettle + HOLD, lastEnd);
  const exitDur = wipeRoom >= minAnim ? Math.round(Math.min(wipeRoom, EXIT)) : 0;
  const exitFrom = exitTo - exitDur;
  // A wipe that a later cue cuts short ends with ink still on its last frame (no blink): it accelerates, it does not settle.
  const wipeEase = ctl.limit < cue.endMs ? EASES.in : EASES.inOut;
  const wipeP = (t: number) => wipeEase(prog(t, exitFrom, exitDur));
  /** Export frames a piece paints ink on (visible, not transparent, not clipped away). */
  const paintedFrames = (piece: Piece) => exportFrameTimes(piece.fromMs, piece.toMs, fps).filter((t) => evaluatePiece(piece, t).o > 0 && pieceBounds(piece, t, input.measure) !== null).length;
  /** What survives the cue's cut: nothing that starts after it, and no decoration is painted on a single frame (rule 4). */
  const finish = (list: Piece[]) =>
    clampToSafeArea(
      list.filter((piece) => piece.fromMs < exitTo && piece.toMs > piece.fromMs && (/^cascade:\d+:(w|h)\d+$/.test(piece.id) || paintedFrames(piece) >= 2)),
      safe,
      input.measure,
    );

  const chan = (fn: (t: number) => number, from: number, to: number, edges: readonly number[], tolerance: number): Frames =>
    sampleFrames(fn, [from, ...edges, to], tolerance, { range: [from, to], wholeMs: true, simplify: true });

  // --- planning a block of lockup rows ---
  const plan = (indices: readonly number[], sizeS: number, limit: number, indentC: number): Plan => {
    const sizeC = sizeS * u;
    const gap = gapOf(sizeC);
    const widths = indices.map((index) => adv(texts[index]!, sizeC));
    let rows = balancedRows(widths, gap, limit);
    for (let pass = 0; pass < 4; pass++) {
      const next = balancedRows(widths, gap, Math.max(0.3 * limit, limit - Math.max(0, rows.length - 1) * indentC));
      if (next.length === rows.length) {
        rows = next;
        break;
      }
      rows = next;
    }
    const lineH = LINE_EM * sizeC;
    const laid: Row[] = rows.map((row, r) => {
      const order = rowVisualOrder(row.map((at) => texts[indices[at]!]!), direction).map((at) => row[at]!);
      const ws = order.map((at) => widths[at]!);
      const width = ws.reduce((a, b) => a + b, 0) + gap * (order.length - 1);
      return { items: order.map((at, position) => ({ index: indices[at]!, lx: 0, w: ws[position]! })), width, ly: r * lineH };
    });
    const blockW = Math.max(...laid.map((row, r) => row.width + r * indentC));
    return { sizeC, rows: laid, blockW, blockH: rows.length * lineH, lineH };
  };
  /** Places a plan's rows: flush to the leading edge with a stair indent, or centred. */
  const place = (p: Plan, indentC: number, centred: boolean, top: number): Plan => {
    const gap = gapOf(p.sizeC);
    const rows = p.rows.map((row, r): Row => {
      const start = centred ? -row.width / 2 : rtl ? -(r * indentC) - row.width : r * indentC;
      let lx = start;
      const items = row.items.map((item) => {
        const placed = { ...item, lx };
        lx += item.w + gap;
        return placed;
      });
      return { items, width: row.width, ly: top + r * p.lineH };
    });
    return { ...p, rows };
  };

  const pieces: Piece[] = [];

  // --- shared pieces of the template's language ---
  const drift = (frameDrift: boolean) => (t: number) => (frameDrift ? sgn * DRIFT_PX * u * clamp((t - cue.startMs) / DRIFT_MS) : 0);
  const word = (
    id: string,
    index: number,
    sizeC: number,
    fr: Frame,
    lx: number,
    w: number,
    ly: number,
    from: number,
    dr: (t: number) => number,
    fill: string,
    extra: { shadows?: TextPiece["shadows"]; o: Frames; xOff?: (t: number) => number; clip?: boolean; ends?: number; z: number },
  ): TextPiece => {
    const cxl = lx + w / 2;
    const cyl = ly + sizeC / 2;
    const base = { x: fr.ex + cxl * fr.cos - cyl * fr.sin, y: fr.ey + cxl * fr.sin + cyl * fr.cos };
    const off = extra.xOff ?? (() => 0);
    const to = extra.ends ?? exitTo;
    const track: Track = {
      x: chan((t) => base.x + dr(t) + off(t) * fr.cos, from, to, [cue.startMs + DRIFT_MS], 0.15),
      y: chan((t) => base.y + off(t) * fr.sin, from, to, [], 0.15),
      rz: frame(from, fr.theta),
      skx: frame(from, sheared(index) ? SHEAR * sgn : 0),
      o: extra.o,
    };
    const clip: Clip | undefined = extra.clip ? wipeClip(fr, cyl, dr, from, to) : undefined;
    return {
      id: `cascade:${cueNumber}:${id}`,
      kind: "text",
      z: band + extra.z,
      fromMs: from,
      toMs: to,
      track,
      ...(clip ? { clip } : {}),
      origin: { dx: w / 2, dy: sizeC / 2 - baseOf(sizeC) },
      text: texts[index]!,
      face: FACE,
      sizePx: sizeC,
      letterSpacingEm: LS,
      fill,
      ...(extra.shadows ? { shadows: extra.shadows } : {}),
      anchor: "baseline-left",
      language: cue.language,
    };
  };
  // The wipe edge, in the frame's local x, starts left of everything (right for a right-to-left cue) and sweeps across.
  let edgeFrom = 0;
  let edgeTo = 0;
  const edgeLx = (t: number) => lerp(edgeFrom, edgeTo, wipeP(t));
  const cutX = (fr: Frame, t: number, lyc: number, dr: (t: number) => number) => fr.ex + edgeLx(t) * fr.cos - lyc * fr.sin + dr(exitFrom);
  function wipeClip(fr: Frame, lyc: number, dr: (t: number) => number, from: number, to: number): Clip {
    const cut = chan((t) => cutX(fr, t, lyc, dr), from, to, [exitFrom, exitTo], 0.3);
    const far = frame(from, OPEN_EDGE);
    const near = frame(from, -OPEN_EDGE);
    // Full height: the wipe is a vertical edge, so a tall script (Arabic, Devanagari) is never cut above or below.
    return { x1: rtl ? near : cut, x2: rtl ? cut : far, y1: frame(from, -OPEN_EDGE), y2: frame(from, OPEN_EDGE) };
  }

  /** Local coordinates -> canvas for a frame. */
  const at = (fr: Frame, lx: number, ly: number) => ({ x: fr.ex + lx * fr.cos - ly * fr.sin, y: fr.ey + lx * fr.sin + ly * fr.cos });

  const mkFrame = (ex: number, ey: number, theta: number): Frame => ({ ex, ey, theta, cos: Math.cos((theta * Math.PI) / 180), sin: Math.sin((theta * Math.PI) / 180) });

  /** A rule of `thick` px from local lx `a` to `b` at row y `ly`: drawn in (dir 1 = from a, -1 = from b, 0 = from the middle), red / cyan lead, wiped at the exit. */
  const rule = (idBase: string, fr: Frame, a: number, b: number, ly: number, drawFrom: number, drawDur: number, dir: 1 | -1 | 0, dr: (t: number) => number, z: number) => {
    const thick = RULE_THICK * u;
    const n = Math.max(1, Math.ceil((b - a) / (RULE_SEG * u)));
    const len = (b - a) / n;
    const p = (t: number) => EASES.outExpo(prog(t, drawFrom, drawDur));
    const visible = (t: number): [number, number] => {
      const q = p(t);
      if (dir === 1) return [a, a + (b - a) * q];
      if (dir === -1) return [b - (b - a) * q, b];
      const mid = (a + b) / 2;
      return [mid - ((b - a) / 2) * q, mid + ((b - a) / 2) * q];
    };
    for (let i = 0; i < n; i++) {
      const sa = a + i * len;
      const sb = sa + len;
      let first = -1;
      for (let t = drawFrom; t <= drawFrom + drawDur; t += 4) {
        const [va, vb] = visible(t);
        if (Math.min(sb, vb) - Math.max(sa, va) > 0.5) {
          first = t;
          break;
        }
      }
      if (first < 0) continue;
      const from = Math.round(first);
      if (from >= exitFrom) continue;
      const mid = at(fr, (sa + sb) / 2, ly + thick / 2);
      const xl = (l: number, t: number) => at(fr, l, ly + thick / 2).x + dr(t);
      const wipeLimit = (t: number) => cutX(fr, t, ly + thick / 2, dr);
      const tiltY = Math.abs(fr.sin) * len + thick + 4 * u;
      const loRaw = (t: number) => xl(clamp(visible(t)[0], sa, sb), t);
      const hiRaw = (t: number) => xl(clamp(visible(t)[1], sa, sb), t);
      // Never an inverted rectangle: the wipe edge may pass the drawn edge when the exit is short.
      const hi = (t: number) => (rtl ? Math.min(hiRaw(t), wipeLimit(t)) : Math.max(hiRaw(t), Math.max(loRaw(t), wipeLimit(t))));
      const lo = (t: number) => (rtl ? Math.min(loRaw(t), hi(t)) : Math.max(loRaw(t), wipeLimit(t)));
      const x1 = chan(lo, from, exitTo, [drawFrom + drawDur, exitFrom, exitTo, cue.startMs + DRIFT_MS], 0.3);
      const x2 = chan(hi, from, exitTo, [drawFrom + drawDur, exitFrom, exitTo, cue.startMs + DRIFT_MS], 0.3);
      const clip: Clip = { x1, x2, y1: frame(from, mid.y - tiltY), y2: frame(from, mid.y + tiltY) };
      const segLen = sb - sa + 2;
      const mk = (id: string, colour: string, fromT: number, toT: number, shift: ((t: number) => number) | null, o: Frames, zz: number, withClip: boolean): ShapePiece => ({
        id: `cascade:${cueNumber}:${idBase}${i}${id}`,
        kind: "shape",
        z: band + zz,
        fromMs: fromT,
        toMs: toT,
        path: rectPath(0, 0, segLen, thick),
        origin: { dx: segLen / 2, dy: thick / 2 },
        fill: { colour },
        track: {
          x: chan((t) => mid.x + dr(t) - (shift ? shift(t) * fr.sin : 0), fromT, toT, [cue.startMs + DRIFT_MS, ...(shift ? [fromT + 160] : [])], 0.15),
          y: chan((t) => mid.y + (shift ? shift(t) * fr.cos : 0), fromT, toT, shift ? [fromT + 160] : [], 0.15),
          rz: frame(fromT, fr.theta),
          o,
        },
        ...(withClip ? { clip } : {}),
      });
      pieces.push(mk("", WHITE, from, exitTo, null, frame(from, 1), z, true));
      // The lead: red above, cyan below, closing onto the white line over 160 ms from where this segment starts drawing.
      const leadOff = (sign: number) => (t: number) => sign * 6 * u * (1 - EASES.out(prog(t, from, 160)));
      const leadTo = Math.min(from + 160, exitFrom);
      const lead = (sign: number) => (heroNumber + lockupNumber + (seed & 1)) % 2 === 0 ? sign : -sign;
      pieces.push(mk("r", SPLIT_A, from, leadTo, leadOff(lead(-1)), [[from, 1], [leadTo, 0]], z - 1, true));
      pieces.push(mk("c", SPLIT_B, from, leadTo, leadOff(lead(1)), [[from, 1], [leadTo, 0]], z - 1, true));
    }
  };

  const lead = roles.lead;
  const heroIdx = roles.hero;
  const tail = roles.tail;

  if (!hasHero) {
    // ===== a lockup cue: tilted italic rows on a drawn rule =====
    const all = cue.words.map((_, index) => index);
    const frameDrift = true;
    const dr = drift(frameDrift);
    const indentC = INDENT * u;
    const overhang = (RULE_OVER + DRIFT_PX) * u;
    const leftReach = LEFT_REACH * u;
    const availBlock = safeW - leftReach - overhang;
    let k = 1;
    let planned = plan(all, BODY * k, Math.min(WRAP * u, availBlock), indentC);
    // The tilt moves the rule's ends sideways by sin(6 degrees) of their drop below the pivot: counted in the width.
    const tiltReserve = (blockH: number) => Math.abs(Math.sin((TILT * Math.PI) / 180)) * (blockH + 40 * u * k);
    for (let pass = 0; pass < 10; pass++) {
      const wide = planned.blockW + tiltReserve(planned.blockH);
      const tooWide = wide > availBlock;
      const tooTall = planned.blockH + 0.11 * (planned.blockW + leftReach + overhang) > 0.8 * safeH;
      if (!tooWide && !tooTall) break;
      k *= Math.min(tooWide ? availBlock / wide : 1, tooTall ? (0.8 * safeH) / (planned.blockH + 0.11 * (planned.blockW + leftReach + overhang)) : 1) * 0.985;
      planned = plan(all, BODY * k, Math.min(WRAP * u, availBlock), indentC);
    }
    const top = -planned.blockH / 2 - 10 * u;
    const laid = place(planned, indentC, false, top);
    const gMin = rtl ? -(laid.blockW + overhang) : -leftReach;
    const gMax = rtl ? leftReach : laid.blockW + overhang;
    const fr = mkFrame(Cx - (gMin + gMax) / 2, Py, TILT * sgn);
    // The wipe edge leans with the tilt: the margin lets it clear the rule's lower end too.
    edgeFrom = rtl ? gMax + 10 * u : gMin - 10 * u;
    edgeTo = rtl ? gMin - 50 * u : gMax + 50 * u;
    const sizeC = laid.sizeC;
    const k0 = sizeC / (BODY * u);

    // words, split copies, scan bars
    const shadows = [{ dx: 0, dy: 4 * u * k0, blur: 5 * u * k0, colour: colours.shadow, alpha: 0.6 }];
    const wordList: { index: number; row: Row; item: Row["items"][number] }[] = [];
    for (const row of laid.rows) for (const item of row.items) wordList.push({ index: item.index, row, item });
    const swap = (lockupNumber + (seed & 1)) % 2 === 1;
    for (const { index, row, item } of wordList) {
      const s = Math.round(lockupEnter(index));
      const split = splitOf(index);
            const fade = fadeOf(index);
      pieces.push(word(`w${index}`, index, sizeC, fr, item.lx, item.w, row.ly, s, dr, WHITE, { shadows, o: fade > 0 ? ([[s, 0], [s + fade, 1]] as Frames) : frame(s, 1), clip: true, z: 4 }));
      const off = (t: number) => (1 - EASES.out(prog(t, s, split))) * SPLIT_PX * u * k0;
      const ends = Math.min(s + split, exitFrom);
      const oFade: Frames = [[s, 1], [s + split, 0]];
      if (split > 0) {
        pieces.push(word(`w${index}a`, index, sizeC, fr, item.lx, item.w, row.ly, s, dr, swap ? SPLIT_B : SPLIT_A, { o: oFade, xOff: (t) => -off(t), ends, z: 3 }));
        pieces.push(word(`w${index}b`, index, sizeC, fr, item.lx, item.w, row.ly, s, dr, swap ? SPLIT_A : SPLIT_B, { o: oFade, xOff: off, ends, z: 3 }));
      }

      // scan bar: vertical L->R, horizontal top->bottom, vertical R->L, cycled by lockup counter and word
      const variant = (lockupNumber + index + ((seed >>> 3) % 3)) % 3;
      const capH = 0.7 * sizeC;
      const bw = variant === 1 ? item.w : 4 * u * k0;
      const bh = variant === 1 ? 4 * u * k0 : capH;
      const barShear = sheared(index) ? SHEAR * sgn : 0;
      const tanA = Math.tan((barShear * Math.PI) / 180);
      const baseline = baseOf(sizeC);
      const cxl = item.lx + item.w / 2;
      const cyl = row.ly + sizeC / 2;
      const ox = (t: number) => {
        const q = prog(t, s, split);
        if (variant === 0) return lerp(-item.w / 2, item.w / 2, q);
        if (variant === 2) return lerp(item.w / 2, -item.w / 2, q);
        return 0;
      };
      const oy = (t: number) => (variant === 1 ? lerp(baseline - capH - sizeC / 2, baseline - sizeC / 2, prog(t, s, split)) : baseline - capH / 2 - sizeC / 2);
      const barTo = Math.min(s + split + 40, exitFrom);
      const pos = (t: number) => {
        const lx = cxl + ox(t) + tanA * oy(t);
        const ly = cyl + oy(t);
        return at(fr, lx, ly);
      };
      if (split > 0) pieces.push({
        id: `cascade:${cueNumber}:scan${index}`,
        kind: "shape",
        // Behind the white face (z 4): the scan never recolours landed ink.
        z: band + 3,
        fromMs: s,
        toMs: barTo,
        path: rectPath(0, 0, bw, bh),
        origin: { dx: bw / 2, dy: bh / 2 },
        fill: { colour: index % 2 === 0 ? SPLIT_B : SPLIT_A },
        track: {
          x: chan((t) => pos(t).x + dr(t), s, barTo, [s + split, cue.startMs + DRIFT_MS], 0.15),
          y: chan((t) => pos(t).y, s, barTo, [s + split], 0.15),
          rz: frame(s, fr.theta),
          skx: frame(s, barShear),
          o: [[s, 1], [Math.max(s, s + split - 30), 1], [barTo, 0]],
        },
      });
    }

    // the rule under the block
    const ruleY = top + laid.blockH + 14 * u * k0;
    const ruleA = rtl ? -(laid.blockW + RULE_OVER * u) : -leftReach;
    const ruleB = rtl ? leftReach : laid.blockW + RULE_OVER * u;
    // The sample's rule leads the word by 80 ms; a later cue's collision takes that lead back first (`shift`).
    const drawFrom = Math.round(cue.startMs - RULE_LEAD + Math.min(ctl.decor, RULE_LEAD));
    const drawDur = Math.round(clamp(exitFrom - drawFrom - 20, minAnim, 420));
    rule("rule", fr, ruleA, ruleB, ruleY, drawFrom, drawDur, rtl ? -1 : 1, dr, 1);

    return finish(pieces);
  }

  // ===== a hero cue: upright hero with echoes, lockup rows around it =====
  const heroBaseS = HERO_MAX;
  const gapOfS = (s: number) => gapOf(s * u);
  const heroNat = (s: number) => heroIdx.reduce((sum, index) => sum + adv(texts[index]!, s * u), 0) + gapOfS(s) * (heroIdx.length - 1);
  let heroS = Math.min(heroBaseS, (HERO_FIT * u) / (heroNat(100) / 100) / u);
  heroS = Math.min(heroS, (safeW / u) * 0.9 * (100 / (heroNat(100) / u)) );
  const heroSizeC0 = heroS * u;
  const lockS0 = Math.min(BODY, heroS * 0.8);
  const lockLimit = Math.min(WRAP * u, safeW * 0.96);
  const frHero = mkFrame(Cx, Py, 0);
  let kk = 1;
  let heroSizeC = heroSizeC0;
  let leadPlan: Plan | null = null;
  let tailPlan: Plan | null = null;
  let totalH = 0;
  // The vertical range the cue fits (rows, hero ink and echoes), from the frame's y: decoration stays inside it so the shift into the safe area is the same for all.
  let rangeLo = 0;
  let rangeHi = 0;
  const gapL = (sizeC: number) => 0.0 * sizeC;
  // The support rows fit on their own first: the widest row plus its split offsets inside the safe width (a 45-letter word shrinks).
  let ks = 1;
  for (let pass = 0; pass < 8; pass++) {
    const ls = lockS0 * ks;
    const rowsOf = [lead.length > 0 ? plan(lead, ls, lockLimit, 0) : null, tail.length > 0 ? plan(tail, ls, lockLimit, 0) : null];
    const widestRow = Math.max(0, ...rowsOf.map((row) => row?.blockW ?? 0));
    const reach = widestRow + 2 * SPLIT_PX * u * (ls / BODY);
    if (reach <= 0.98 * safeW) break;
    ks *= ((0.98 * safeW) / reach) * 0.99;
  }
  for (let pass = 0; pass < 10; pass++) {
    heroSizeC = heroSizeC0 * kk;
    const ls = lockS0 * ks * kk;
    leadPlan = lead.length > 0 ? plan(lead, ls, lockLimit, 0) : null;
    tailPlan = tail.length > 0 ? plan(tail, ls, lockLimit, 0) : null;
    totalH = (leadPlan?.blockH ?? 0) + heroSizeC + (tailPlan?.blockH ?? 0) + gapL(heroSizeC) * 2;
    // The real extent: the rows, the hero's ink and, on a free side, its echoes (three pitches out, stroke included).
    const echoInk = heroIdx.map((index) => input.measure(texts[index]!, FACE, heroSizeC, LS));
    const baselineRel = -totalH / 2 + (leadPlan?.blockH ?? 0) + gapL(heroSizeC) + baseOf(heroSizeC);
    const reachOut = 3 * ECHO_PITCH * heroSizeC + STROKE * u;
    const lo = Math.min(-totalH / 2, baselineRel + Math.min(...echoInk.map((m) => m.inkTop)) - (leadPlan ? 0 : reachOut));
    const hi = Math.max(totalH / 2, baselineRel + Math.max(...echoInk.map((m) => m.inkBottom)) + (tailPlan ? 0 : reachOut));
    const need = hi - lo + 8 * u;
    rangeLo = lo;
    rangeHi = hi;
    if (need <= 0.98 * safeH) break;
    kk *= ((0.98 * safeH) / need) * 0.99;
  }
  const lp = leadPlan;
  const tp = tailPlan;
  const top0 = -totalH / 2;
  const leadPlaced = lp ? place(lp, 0, true, top0) : null;
  const heroTop = top0 + (lp?.blockH ?? 0) + gapL(heroSizeC);
  const tailPlaced = tp ? place(tp, 0, true, heroTop + heroSizeC + gapL(heroSizeC)) : null;
  const heroGap = gapOf(heroSizeC);
  const heroWidths = heroIdx.map((index) => adv(texts[index]!, heroSizeC));
  const heroW = heroWidths.reduce((a, b) => a + b, 0) + heroGap * (heroIdx.length - 1);
  const heroOrder = rowVisualOrder(heroIdx.map((index) => texts[index]!), direction).map((at2) => heroIdx[at2]!);
  const heroPlace: { index: number; lx: number; w: number }[] = [];
  {
    let lx = -heroW / 2;
    for (const index of heroOrder) {
      const w = adv(texts[index]!, heroSizeC);
      heroPlace.push({ index, lx, w });
      lx += w + heroGap;
    }
  }
  const widest = Math.max(heroW, lp?.blockW ?? 0, tp?.blockW ?? 0);
  const halfExtent = Math.min(widest / 2 + 150 * u, safeW / 2);
  edgeFrom = rtl ? halfExtent : -halfExtent;
  edgeTo = rtl ? -halfExtent : halfExtent;
  const dr0 = drift(false);

  // timing of the cascade
  const heroFirst = Math.min(...heroIdx.map(startOf));
  // A very short cue has its exit right after the hero lands: the cascade then runs to the cut.
  const cEnd = exitFrom - heroFirst >= 100 ? exitFrom : exitTo;
  // Too short for two frames of cascade after the word: the decoration starts with the hero's own entrance.
  const castFrom = cEnd - heroFirst >= 2 * minAnim ? heroFirst : Math.min(...heroIdx.map(heroEnter));
  const avail = cEnd - castFrom;
  const { beat, steps, ruleDur: ruleDur0 } = cascadeBeats(avail, minAnim);
  const pattern = CASCADE_PATTERNS[heroNumber % CASCADE_PATTERNS.length]!.slice(-steps);
  // The rule draws once the cascade has cleared; a cue too short for both runs them together from the hero's onset.
  const roomy = avail >= steps * beat + minAnim;
  const ruleStart = Math.round(roomy ? Math.max(castFrom, Math.min(castFrom + steps * beat, cEnd - minAnim)) : castFrom);
  const ruleDur = Math.max(minAnim, Math.min(ruleDur0, cEnd - ruleStart));

  // lockup rows above and below
  const swap = (heroNumber + (seed & 1)) % 2 === 1;
  const lockShadows = (sizeC: number) => [{ dx: 0, dy: 4 * u * (sizeC / (BODY * u)), blur: 5 * u * (sizeC / (BODY * u)), colour: colours.shadow, alpha: 0.6 }];
  for (const placed of [leadPlaced, tailPlaced]) {
    if (!placed) continue;
    for (const row of placed.rows) {
      for (const item of row.items) {
        const s = Math.round(lockupEnter(item.index));
        const kS = placed.sizeC / (BODY * u);
        const split = splitOf(item.index);
        const fade = fadeOf(item.index);
        pieces.push(word(`w${item.index}`, item.index, placed.sizeC, frHero, item.lx, item.w, row.ly, s, dr0, WHITE, { shadows: lockShadows(placed.sizeC), o: fade > 0 ? ([[s, 0], [s + fade, 1]] as Frames) : frame(s, 1), clip: true, z: 4 }));
        const off = (t: number) => (1 - EASES.out(prog(t, s, split))) * SPLIT_PX * u * kS;
        const ends = Math.min(s + split, exitFrom);
        const oFade: Frames = [[s, 1], [s + split, 0]];
        if (split > 0) {
          pieces.push(word(`w${item.index}a`, item.index, placed.sizeC, frHero, item.lx, item.w, row.ly, s, dr0, swap ? SPLIT_B : SPLIT_A, { o: oFade, xOff: (t) => -off(t), ends, z: 3 }));
          pieces.push(word(`w${item.index}b`, item.index, placed.sizeC, frHero, item.lx, item.w, row.ly, s, dr0, swap ? SPLIT_A : SPLIT_B, { o: oFade, xOff: off, ends, z: 3 }));
        }
      }
    }
  }

  // the hero: upright (no shear), punch from blur and 1.14x
  const heroCy = heroTop + heroSizeC / 2;
  const heroBase = baseOf(heroSizeC);
  const heroShadows = [{ dx: 0, dy: 4 * u * (heroSizeC / (BODY * u)) * 0.5, blur: 6 * u, colour: colours.shadow, alpha: 0.6 }];
  const heroCentre = at(frHero, 0, heroCy);
  const pitch = ECHO_PITCH * heroSizeC;
  const stepX = Math.min(110 * u, Math.max(18 * u, (safeW / 2 - heroW / 2 - 12 * u) / 3));
  const freeUp = lp === null;
  const freeDown = tp === null;
  const horizontal = !freeUp && !freeDown;
  const stepH = Math.min(0.2 * heroSizeC, Math.max(14 * u, (safeW / 2 - heroW / 2 - 8 * u) / 3));
  const echoKs = [-3, -2, -1, 1, 2, 3].filter((k) => horizontal || (k < 0 ? freeUp : freeDown));
  const pieceAt = (lx: number, w: number) => ({ x: frHero.ex + lx + w / 2, y: heroCentre.y });
  for (const hp of heroPlace) {
    const s = Math.round(heroEnter(hp.index));
    const p0 = pieceAt(hp.lx, hp.w);
    const punch = punchOf(hp.index);
    const fullClip = wipeClip(frHero, 0, dr0, s, exitTo);
    pieces.push({
      id: `cascade:${cueNumber}:h${hp.index}`,
      kind: "text",
      z: band + 4,
      fromMs: s,
      toMs: exitTo,
      track: {
        x: frame(s, p0.x),
        y: frame(s, p0.y),
        ...(punch > 0
          ? {
              sx: [[s, 1.14], [s + punch, 1, "outExpo"]] as Frames,
              sy: [[s, 1.14], [s + punch, 1, "outExpo"]] as Frames,
              blur: [[s, 14 * u], [s + punch, 0, "outExpo"]] as Frames,
            }
          : {}),
      },
      clip: fullClip,
      origin: { dx: hp.w / 2, dy: heroSizeC / 2 - heroBase },
      text: texts[hp.index]!,
      face: FACE,
      sizePx: heroSizeC,
      letterSpacingEm: LS,
      fill: WHITE,
      shadows: heroShadows,
      anchor: "baseline-left",
      language: cue.language,
    });
    // echoes: one static piece per beat and copy
    pattern.forEach((mode, step) => {
      if (mode === "none") return;
      const from = Math.round(Math.max(castFrom + step * beat, s));
      const to = Math.round(Math.min(castFrom + (step + 1) * beat, cEnd));
      if (to <= from) return;
      for (const k of echoKs) {
        const dx = horizontal ? (mode === "stair" ? -k * stepH : mode === "stair2" ? k * stepH : k * stepH) : mode === "stair" ? -k * stepX : mode === "stair2" ? k * stepX : 0;
        const dy = horizontal ? 0 : k * pitch;
        pieces.push({
          id: `cascade:${cueNumber}:e${hp.index}s${step}k${k}`,
          kind: "text",
          z: band + 2,
          fromMs: from,
          toMs: to,
          track: { x: frame(from, p0.x + dx), y: frame(from, p0.y + dy), o: frame(from, [1, 0.72, 0.45][Math.abs(k) - 1]!) },
          origin: { dx: hp.w / 2, dy: heroSizeC / 2 - heroBase },
          text: texts[hp.index]!,
          face: FACE,
          sizePx: heroSizeC,
          letterSpacingEm: LS,
          fill: WHITE,
          fillAlpha: 0,
          stroke: { widthPx: STROKE * u, colour: WHITE },
          anchor: "baseline-left",
          language: cue.language,
        });
      }
    });
  }

  // register brackets close in on the hero
  {
    const capTop = frHero.ey + heroTop + heroBase + input.measure("H", FACE, heroSizeC, LS).inkTop;
    const capBot = frHero.ey + heroTop + heroBase;
    const pad = 0.12 * heroSizeC;
    const hw = heroW / 2 + pad;
    const hh = (capBot - capTop) / 2 + pad;
    const cyB = (capTop + capBot) / 2;
    const arm = clamp(0.2 * heroSizeC, 12 * u, 36 * u);
    const th = Math.max(4 * u, 0.04 * heroSizeC);
    const variant = heroNumber % 3;
    const diag = (heroNumber + (seed & 1)) % 2 === 0;
    const from = Math.round(heroFirst - HERO_LEAD + wordShift);
    const dur = 170;
    const s0max = variant === 1 ? 1.6 : 1.35;
    const s0 = Math.max(1, Math.min(s0max, (safeW / 2 - arm) / hw, (Math.min(frHero.ey + rangeHi - cyB, cyB - (frHero.ey + rangeLo)) - arm) / Math.max(hh, 1)));
    const corner = (sx: -1 | 1, sy: -1 | 1): [number, number][] => {
      // an L whose corner is at (0,0) and arms run toward the centre
      const ax = -sx;
      const ay = -sy;
      return [[0, 0], [ax * arm, 0], [ax * arm, ay * th], [ax * th, ay * th], [ax * th, ay * arm], [0, ay * arm]];
    };
    const bracket = (sx: -1 | 1): [number, number][] => {
      const ax = -sx;
      const H = hh * 2;
      return [[0, -hh], [ax * arm, -hh], [ax * arm, -hh + th], [ax * th, -hh + th], [ax * th, hh - th], [ax * arm, hh - th], [ax * arm, hh], [0, hh]].map(([x, y]) => [x!, y! + hh - H / 2 + 0] as [number, number]);
    };
    const specs: { id: string; pts: [number, number][]; sx: -1 | 1; sy: -1 | 1 | 0 }[] = [];
    if (variant === 0) for (const sx of [-1, 1] as const) for (const sy of [-1, 1] as const) specs.push({ id: `${sx}${sy}`, pts: corner(sx, sy), sx, sy });
    else if (variant === 1) for (const [sx, sy] of (diag ? [[-1, -1], [1, 1]] : [[1, -1], [-1, 1]]) as [-1 | 1, -1 | 1][]) specs.push({ id: `${sx}${sy}`, pts: corner(sx, sy), sx, sy });
    else for (const sx of [-1, 1] as const) specs.push({ id: `${sx}`, pts: bracket(sx), sx, sy: 0 });
    for (const spec of specs) {
      const xs = spec.pts.map((p) => p[0]);
      const ys = spec.pts.map((p) => p[1]);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const path = polygonPath(spec.pts.map(([x, y]) => [x - minX, y - minY] as [number, number]));
      const origin = { dx: -minX, dy: -minY };
      const px = (t: number) => frHero.ex + spec.sx * hw * lerp(s0, 1, EASES.outExpo(prog(t, from, dur)));
      const py = (t: number) => cyB + spec.sy * hh * lerp(s0, 1, EASES.outExpo(prog(t, from, dur)));
      const x1 = chan((t) => cutX(frHero, t, 0, dr0), from, exitTo, [exitFrom, exitTo], 0.3);
      const far = frame(from, space.canvas.width + 80);
      const near = frame(from, -80);
      pieces.push({
        id: `cascade:${cueNumber}:br${spec.id}`,
        kind: "shape",
        z: band + 5,
        fromMs: from,
        toMs: exitTo,
        path,
        origin,
        fill: { colour: WHITE },
        track: {
          x: chan(px, from, exitTo, [from + dur], 0.2),
          y: chan(py, from, exitTo, [from + dur], 0.2),
          o: [[from, 0], [from + 50, 1]],
        },
        clip: { x1: rtl ? near : x1, x2: rtl ? x1 : far, y1: frame(from, -OPEN_EDGE), y2: frame(from, OPEN_EDGE) },
      });
    }
  }

  // the level rule under the whole block, drawn when the cascade clears: left, right or from the middle
  {
    const ruleW = Math.min(widest + 120 * u, safeW);
    const bottom = (tailPlaced ? tailPlaced.rows[tailPlaced.rows.length - 1]!.ly + tailPlaced.lineH : heroTop + heroSizeC) + 0.08 * heroSizeC - (tailPlaced ? 0.12 * tailPlaced.sizeC : 0);
    const dirCycle: (1 | -1 | 0)[] = [1, -1, 0];
    const raw = dirCycle[heroNumber % 3]!;
    const dir = raw === 0 ? 0 : ((raw * sgn) as 1 | -1);
    rule("rule", frHero, -ruleW / 2, ruleW / 2, bottom, ruleStart, ruleDur, dir, dr0, 1);
  }

  return finish(pieces);
}

/** Where a piece ever draws: the union of its boxes over its life (null when it never shows). */
function lifeBox(piece: Piece, measure: Measure): Box | null {
  let box: Box | null = null;
  const stamp = (t: number) => {
    const at = pieceBounds(piece, t, measure);
    if (!at) return;
    box = box ? { x1: Math.min(box.x1, at.x1), y1: Math.min(box.y1, at.y1), x2: Math.max(box.x2, at.x2), y2: Math.max(box.y2, at.y2) } : at;
  };
  for (let t = piece.fromMs; t < piece.toMs; t += 16) stamp(t);
  stamp(piece.toMs - 1);
  return box;
}

const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const moved = (box: Box, dy: number): Box => ({ x1: box.x1, x2: box.x2, y1: box.y1 + dy, y2: box.y2 + dy });
const isFace = (piece: Piece) => /^cascade:\d+:(w|h)\d+$/.test(piece.id);
const joinBoxes = (boxes: readonly Box[]): Box | null =>
  boxes.length === 0 ? null : { x1: Math.min(...boxes.map((b) => b.x1)), y1: Math.min(...boxes.map((b) => b.y1)), x2: Math.max(...boxes.map((b) => b.x2)), y2: Math.max(...boxes.map((b) => b.y2)) };

type Quad = readonly (readonly [number, number])[];

/** A piece's rest box carried through its pose (scale, shear, turn) at `t`: the oriented box the ink sits in. Null while it is not visible. */
function quadAt(piece: Piece, t: number, measure: Measure, dy = 0): Quad | null {
  const pose = evaluatePiece(piece, t);
  if (!pose.visible || pose.o <= 0) return null;
  const local = pieceLocalBox(piece, measure);
  const origin = piece.origin ?? { dx: 0, dy: 0 };
  const angle = (pose.rz * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const shear = Math.tan((pose.skx * Math.PI) / 180);
  return ([[local.x1, local.y1], [local.x2, local.y1], [local.x2, local.y2], [local.x1, local.y2]] as const).map(([cx, cy]) => {
    const uy = (cy - origin.dy) * pose.sy;
    const ux = (cx - origin.dx) * pose.sx + shear * uy;
    return [pose.x + ux * cos - uy * sin, pose.y + dy + ux * sin + uy * cos] as const;
  });
}

/** Do two convex quads share more than a pixel of area (separating-axis test)? */
function quadsMeet(a: Quad, b: Quad): boolean {
  for (const shape of [a, b]) {
    for (let at = 0; at < shape.length; at++) {
      const [x1, y1] = shape[at]!;
      const [x2, y2] = shape[(at + 1) % shape.length]!;
      const nx = y1 - y2;
      const ny = x2 - x1;
      const length = Math.hypot(nx, ny) || 1;
      const project = (quad: Quad) => {
        const values = quad.map(([x, y]) => (x * nx + y * ny) / length);
        return [Math.min(...values), Math.max(...values)] as const;
      };
      const [aLo, aHi] = project(a);
      const [bLo, bHi] = project(b);
      if (aHi - bLo < 0.25 || bHi - aLo < 0.25) return false;
    }
  }
  return true;
}

/**
 * The first export frame on which piece `q` of a later cue is drawn over one of the earlier pieces `words` (their oriented ink boxes
 * meet), those counted as they are drawn from their own first frame, uncut. `dyQ` and each `dy` are lanes.
 */
function coverFrame(q: Piece, dyQ: number, words: readonly { piece: Piece; dy: number; box: Box }[], measure: Measure, qBox: Box, fps: number): number | null {
  if (!words.some((word) => overlaps(moved(qBox, dyQ), moved(word.box, word.dy)))) return null;
  for (const t of exportFrameTimes(q.fromMs, q.toMs, fps)) {
    if (!(evaluatePiece(q, t).o > 0) || !pieceBounds(q, t, measure)) continue;
    const mine = quadAt(q, t, measure, dyQ);
    if (!mine) continue;
    for (const word of words) {
      if (t < word.piece.fromMs) continue;
      const theirs = quadAt({ ...word.piece, toMs: Number.POSITIVE_INFINITY }, t, measure, word.dy);
      if (theirs && quadsMeet(mine, theirs)) return t;
    }
  }
  return null;
}

const inkId = (piece: Piece) => /^cascade:\d+:(w|h)\d+[ab]?$/.test(piece.id);
const decorId = (piece: Piece) => /^cascade:\d+:(e\d|br|scan)/.test(piece.id);

/**
 * The handoff rule between cues (`gallery3-brief.md`), in its order: the earlier cue's exit gives way (a wipe shortens or drops
 * inside `buildCue`); cues whose real, oriented ink does not meet overlap freely; a later cue that collides gives up lead only as far
 * as the earlier cue's reading hold needs, its decoration (the rule's lead) before its words' lead, never past the last export frame
 * before a word's spoken start; only then do the earlier cue's entrance effects compress, per word, and the cue end at the first
 * frame a colliding piece of the later cue paints. Speakers who talk over each other, or who need the same space while the earlier
 * one still has words to say, get a second lane clear of the earlier cue's words and live decoration; decoration the later cue's
 * words still cover is trimmed before any word is cut. Cues are built last to first, so every cut comes from the later cues'
 * actual, final pieces.
 */
function orchestrate(input: SceneInput, probes: readonly Piece[][], variants: readonly { hero: number; lockup: number }[]): Piece[][] {
  const cues = input.cues;
  const { measure } = input;
  const fps = input.fps ?? SCENE_DEFAULT_FPS;
  const space = sceneSpace(input, CENTER_Y);
  const cache = new Map<Piece, Box | null>();
  const boxOf = (piece: Piece) => {
    if (!cache.has(piece)) cache.set(piece, lifeBox(piece, measure));
    return cache.get(piece)!;
  };
  const n = cues.length;
  const caps = cues.map((cue) => cascadeWordCap(cue, fps));
  const faces = probes.map((list) => list.filter(isFace));
  const heroCue = cues.map((cue) => cue.words.some((word) => word.role === "hero"));
  const endOf = cues.map((cue) => Math.max(cue.endMs, ...cue.words.map((word) => word.endMs)));
  const dy = cues.map(() => 0);
  const shift = cues.map(() => 0);
  const decor = cues.map(() => 0);
  const entries = (list: readonly Piece[], at: number) =>
    list.flatMap((piece) => {
      const box = boxOf(piece);
      return box ? [{ piece, dy: dy[at]!, box }] : [];
    });
  const wordsOf = (i: number) => entries(faces[i]!, i);
  /** How a probe piece of cue j moves when j gives up lead: 0 never, 1 with the rule's lead, 2 with the words'. */
  const kindOf = (piece: Piece, j: number) => {
    const id = piece.id.split(":").slice(2).join(":");
    if (/^e\d/.test(id)) return 0;
    if (/^rule\d+[rc]?$/.test(id)) return heroCue[j] ? 0 : 1;
    return 2;
  };
  const moveBy = (kind: number, j: number, dw: number, dd: number) => (kind === 0 ? 0 : kind === 1 ? Math.min(dd, RULE_LEAD) : Math.min(dw, caps[j]!));
  /** The pieces of cue j that meet cue i's words, with the first frame each does (before any shift). */
  const meets = (i: number, j: number) => {
    const words = wordsOf(i);
    const out: { piece: Piece; at: number; kind: number }[] = [];
    for (const piece of probes[j]!) {
      const box = boxOf(piece);
      if (!box) continue;
      const at = coverFrame(piece, dy[j]!, words, measure, box, fps);
      if (at !== null) out.push({ piece, at, kind: kindOf(piece, j) });
    }
    return out;
  };
  const near = (i: number, j: number) => {
    if (faces[i]!.length === 0 || probes[j]!.length === 0) return false;
    return Math.min(...probes[j]!.map((piece) => piece.fromMs)) - 100 <= endOf[i]! + 400;
  };
  const enterOf = (i: number, face: Piece) => face.fromMs + Math.min(shift[i]!, caps[i]!);

  for (let j = 0; j < n; j++) {
    if (probes[j]!.length === 0) continue;
    // 1. A second lane for a speaker who talks over one that still has words to say, or who would silence one.
    for (let i = 0; i < j; i++) {
      if (!near(i, j)) continue;
      const hit = meets(i, j);
      const earliest = Math.min(...probes[j]!.map((piece) => piece.fromMs));
      const talkingOver = cues[j]!.words[0]!.startMs < Math.max(...cues[i]!.words.map((word) => word.endMs));
      const best = hit.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...hit.map((entry) => entry.at + moveBy(entry.kind, j, RULE_LEAD, RULE_LEAD)));
      const dropped = faces[i]!.some((face) => enterOf(i, face) >= best);
      if (!dropped && !talkingOver) continue;
      // The lane clears the earlier cue's words and the decoration still alive when the later cue appears (hero echoes reach far).
      const alive = probes[i]!.filter((piece) => isFace(piece) || (decorId(piece) && piece.toMs > earliest));
      const wordsOnly = probes[i]!.filter(isFace);
      const gap = 16 * space.u;
      const own = (all: boolean) => joinBoxes(probes[j]!.filter((piece) => all || isFace(piece)).map((piece) => boxOf(piece)).filter((box): box is Box => box !== null).map((box) => moved(box, dy[j]!)));
      let placed = false;
      for (const rivalSet of [alive, wordsOnly]) {
        const rival = joinBoxes(entries(rivalSet, i).map((entry) => moved(entry.box, entry.dy)));
        if (!rival) continue;
        for (const all of [true, false]) {
          const mine = own(all);
          if (!mine) continue;
          const up = rival.y1 - gap - mine.y2;
          const down = rival.y2 + gap - mine.y1;
          const fits = (by: number) => mine.y1 + by >= space.safe.y1 && mine.y2 + by <= space.safe.y2;
          const choice = fits(up) ? up : fits(down) ? down : null;
          if (choice !== null) {
            dy[j] = dy[j]! + choice;
            placed = true;
            break;
          }
        }
        if (placed) break;
      }
    }
    // 2. Give up lead only as far as the earlier cues' settled word and reading hold need: the rule's lead (decoration) first,
    //    the words' lead only when the words themselves must yield.
    for (let i = 0; i < j; i++) {
      if (!near(i, j)) continue;
      const hit = meets(i, j);
      if (hit.length === 0) continue;
      const last = faces[i]!.reduce((a, b) => (a.fromMs >= b.fromMs ? a : b));
      const target = enterOf(i, last) + (/:h\d+$/.test(last.id) ? Math.round(0.7 * HERO_PUNCH) : Math.max(FADE_MS, minAnimOf(fps))) + HOLD;
      const reach = (dw: number, dd: number) => Math.min(...hit.map((entry) => entry.at + moveBy(entry.kind, j, dw, dd)));
      const goal = Math.min(target, reach(caps[j]!, RULE_LEAD));
      // Decoration must not cut the earlier words before the later cue's own word ink paints (that would blink): it waits for it.
      const wordFrom = Math.min(...probes[j]!.filter(inkId).map((piece) => piece.fromMs));
      const inkFrame = (dw: number) => exportFrameAtOrAfter(wordFrom + Math.min(dw, caps[j]!), fps);
      const loose = hit.filter((entry) => !inkId(entry.piece));
      const looseReach = (dw: number, dd: number) => Math.min(Number.POSITIVE_INFINITY, ...loose.map((entry) => entry.at + moveBy(entry.kind, j, dw, dd)));
      let pick: [number, number] | null = null;
      for (let dw = 0; dw <= caps[j]! && !pick; dw++) {
        for (let dd = 0; dd <= RULE_LEAD; dd++) {
          if (reach(dw, dd) >= goal && looseReach(dw, dd) >= inkFrame(dw)) {
            pick = [dw, dd];
            break;
          }
        }
      }
      const [dw, dd] = pick ?? [caps[j]!, RULE_LEAD];
      shift[j] = Math.max(shift[j]!, dw);
      decor[j] = Math.max(decor[j]!, dd);
    }
  }

  // 3. Build last to first: each cue's cut is the first frame a later cue's real, final piece paints over its words.
  const built: Piece[][] = cues.map(() => []);
  for (let i = n - 1; i >= 0; i--) {
    if (probes[i]!.length === 0) continue;
    let limit = Number.POSITIVE_INFINITY;
    const words = wordsOf(i);
    const later = Array.from({ length: n - i - 1 }, (_, at) => i + 1 + at).filter((j) => built[j]!.length > 0 && Math.min(...built[j]!.map((piece) => piece.fromMs)) - 100 <= endOf[i]! + 400);
    for (const j of later) {
      if (words.length === 0) break;
      for (const piece of built[j]!) {
        if (piece.fromMs >= limit) continue;
        const box = boxOf(piece);
        if (!box) continue;
        const at = coverFrame(piece, 0, words, measure, box, fps);
        if (at !== null) limit = Math.min(limit, at);
      }
    }
    const ctl: Control = { shift: shift[i]!, decor: decor[i]!, limit, dy: dy[i]! };
    let mine = ctl.shift === 0 && ctl.decor === 0 && ctl.dy === 0 && !Number.isFinite(ctl.limit) ? probes[i]! : buildCue(cues[i]!, i, input, variants[i]!, ctl);
    // Decoration (echoes, brackets, scan bars) a later cue's word ink still covers ends before it, ahead of any word.
    const ink = later.flatMap((j) => built[j]!.filter(inkId));
    if (ink.length > 0) {
      mine = mine.flatMap((piece) => {
        if (!decorId(piece)) return [piece];
        const box = lifeBox(piece, measure);
        if (!box) return [piece];
        let cut = Number.POSITIVE_INFINITY;
        for (const q of ink) {
          const qBox = boxOf(q);
          if (!qBox) continue;
          const at = coverFrame(q, 0, [{ piece, dy: 0, box }], measure, qBox, fps);
          if (at !== null) cut = Math.min(cut, at);
        }
        if (!Number.isFinite(cut)) return [piece];
        const trimmed = { ...piece, toMs: Math.min(piece.toMs, cut) };
        const painted = exportFrameTimes(trimmed.fromMs, trimmed.toMs, fps).filter((t) => evaluatePiece(trimmed, t).o > 0 && pieceBounds(trimmed, t, measure) !== null).length;
        return trimmed.toMs > trimmed.fromMs && painted >= 2 ? [trimmed] : [];
      });
    }
    built[i] = mine;
  }
  return built;
}

export const cascadeProgram: SceneProgram = {
  build(input) {
    let heroes = 0;
    let lockups = 0;
    const variants = input.cues.map((cue) => {
      if (cue.words.length === 0) return { hero: 0, lockup: 0 };
      return cue.words.some((word) => word.role === "hero") ? { hero: heroes++, lockup: 0 } : { hero: 0, lockup: lockups++ };
    });
    const probes = input.cues.map((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, input, variants[number]!)));
    return { pieces: orchestrate(input, probes, variants).flat() };
  },
};
