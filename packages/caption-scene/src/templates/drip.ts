import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, EASES, type Frames } from "../ease";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes, paintedFrameCount } from "../frame-grid";
import type { SceneCue, SceneWord } from "../input";
import type { Box, Clip, PathCmd, Piece, ShapePiece, TextPiece } from "../scene";
import { ellipsePath } from "../shapes";
import { galleryScene, rowsOf } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Drip (`samples/templates/m86-drip.js`, after Motion Array "Scripted Journey Title"): fat brush-marker words (Knewave)
 * that write on with a fast brush wipe in reading direction, white with a short hard coral offset. The key word is
 * larger, painted turquoise (lime on every other key word), on its own row, and a fat coral brush stroke wipes in under
 * it as it is spoken.
 *
 * Changes from the sample, and why:
 * - **No drips (owner, 2026-11-27: "Don't add the vertical drops").** The sample's paint drips and beads under the key
 *   word are gone, and nothing hangs below the letters as a vertical run. The key word's beat is now a short fat brush
 *   underline in the offset coral that wipes in under it on its spoken start and stays inside its row: its lowest point
 *   is at most a quarter of the key word's size below the key word's ink (a test keeps drips from coming back). It cycles
 *   three strokes by key-word counter (a tapered swash, a swash whose tail lifts, a broken double dash), its length and
 *   wobble jittered by a seeded hash.
 * - **Level, centred rows; the key word alone on its row.** The sample rode the block 2.4 degrees uphill with the second
 *   line stepped 44 px right, which is Swoosh's staircase (Sol's demo review: "Swoosh is closer ... since both use a
 *   stepped layout and coral offset"); Drip now reads as a level brush title block with its own key-word row, so the two
 *   brush styles look clearly different. Words before the key word sit above it, words after it below; rows are balanced
 *   from measured widths. A word wider than the 880 px column shrinks to a floor (0.62 of the body, the body size for a
 *   key word) and below it breaks into the fewest even rows (Latin, Cyrillic, Greek, CJK, Hangul; a joined script never
 *   breaks, it shrinks); a cue that stacks more than three rows is laid out at the largest of two smaller scales that
 *   packs it into fewer. Only a cue's first key word gets the key-word size, colour and underline (the scorer can mark two
 *   on real cues, and two 190 px rows climbed out of the band); a second reads as an ordinary word.
 * - **Readable at onset.** A word's wipe starts at most 100 ms before its spoken start and runs 120 ms on a fast-out ease
 *   (the sample's 150/170 ms ran past the onset and cut the key word's last letter, Sol rounds 1-2), so the word is 99%
 *   written on its spoken start and whole 20 ms later, compressed into a short word's own time so it is whole by its last
 *   frame. A word with no time before its onset (continuous speech hands a cue no lead) prints whole at the onset, as
 *   Receipt does, instead of being cut at its spoken start. The clip edge moves on the export frame grid, so libass and the
 *   Studio show the same edge on the same frame. The stroke leans in (a small shear) while it writes and is upright when
 *   whole, as in the sample. The clip and the coral offset are one piece per word: the offset is the word's own hard
 *   shadow, so it is cut by the same wipe and moves with the word when the cue is shifted into a speaker lane.
 * - **Every language.** The wipe reveals a whole word, so joined scripts are never split into letters; right-to-left cues
 *   read right to left and the wipe, brush tip, underline and spatter mirror. Mixed case as spoken (no case transform).
 *   Knewave draws no Devanagari, Arabic or CJK: those use the glyph fallback face, measured as drawn, and rows, the
 *   underline and the spatter take their size from that measured ink.
 * - **Cue exit.** The sample's 105 ms fade of the whole cue, at the end of the shared cue window, only when two painted
 *   frames fit after every word has read 150 ms; otherwise the next cue simply replaces it.
 * - **Separation on busy footage.** The sample's soft blurred dark shadow costs on every frame; each word has a thin dark
 *   keyline instead, and every colour as received (brand or direct Studio colours) keeps 3:1 against it, else the style's
 *   own. A brand key-word colour is used on every key word; the turquoise/lime alternation is the default palette's.
 *
 * Cost: one text piece per word (keyline and coral offset ride on it), short-lived tips, one underline, two or three
 * flecks; no blur. Full export 1.14x Headline (CPU).
 *
 * Extra recurring beats, in the brush's own paint language:
 * - **Brush tip.** A short slanted coral smear rides the wipe edge of every word that writes on, behind the lettering, and
 *   is gone on the frame before the word is whole.
 * - **Spatter.** As each cue's last word finishes writing, two or three paint flecks (coral and the word's colour) flick
 *   off its reading end and hold, in free space beside the row (or above its end when the row is full width), never on a
 *   word, never below the key word.
 *
 * Words per cue: 4 (on the real-cue sheets, en and hi, every cue fits at full size in one to three rows, no fit shrink). Emoji slot: the default (above): the underline and the spatter keep the
 * space above each cue free.
 */

export const DRIP_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m permission:h@660",
    "nobody:b is:m coming:b to:m save:b you:b",
    "just:m start:h@600 now:b",
    "keep:b showing:b up:m consistency:h@680",
    "you:m got:b this:b",
  ],
  options: { rate: 135, gap: 25, cueGap: 600, tail: 420, lead: 200 },
};

const FACE = "Knewave" as const;
const ANCHOR = 1290;
/** Words around a key word, words of a cue with none, the key word (sample px). */
const BODY = 104;
const SOLO = 124;
const HERO = 190;
const COLUMN = 880;
const GAP = 26;
const PAD = 36;
const FLOOR = 0.62;
/** Smaller scales tried when a cue would stack more than three rows. */
const SCALES = [0.9, 0.8] as const;

const WHITE = "#FFFFFF";
const TURQUOISE = "#1FE6B4";
const LIME = "#C6F23A";
const CORAL = "#FF3B4E";
const INK = "#16090D";
/** Thin dark keyline and the coral offset, em of the word's size. */
const KEYLINE = 0.032;
const OFFSET = 0.055;
const HERO_OFFSET = 0.05;

/** How early a cue's window opens before its first word (the conformance limit is 100). */
const LEAD = 96;
const WRITE_LEAD = 100;
const WRITE = 120;
const LEAN = 8;
const UNDER_MS = 150;
const FLECK_MS = 90;
const FLECK_STAGGER = 35;
const EXIT = 105;
/** The underline's lowest point below its baseline, em of the key word (its own depth plus the keyline). */
const UNDER_Y = 0.2;
const UNDER_T = 0.155;
/** Extra room under the key word's row, em of the key word. */
const UNDER_ROOM = 0.08;

/** Scripts a word wider than the column may break in (between graphemes). Joined and complex scripts never do. */
const BREAKABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}\p{P}\p{S}\p{M}]+$/u;
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{P}\p{N}]+$/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) => [...GRAPHEMES.segment(text)].map((part) => part.segment);

type Key = [number, number, ("out" | "outBack" | "in")?];

function cueSeed(cue: SceneCue): number {
  let hash = (cue.index + 1) * 2654435761;
  for (const word of cue.words) for (const char of word.text) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return (hash >>> 0) / 2 ** 32;
}

const hasHero = (cue: SceneCue) => cue.words.some((word) => word.role === "hero");

/**
 * A fat tapered brush stroke along +x from 0 to `length`, centred on y = 0: a round-ish loaded head, then a taper to a dry
 * tail. `lift` raises the tail (negative y) over the last 30%; `wobble` bends the centre line a little.
 */
function brushStroke(x0: number, length: number, thick: number, lift: number, wobble: number): PathCmd[] {
  const steps = 10;
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const width = thick * (p < 0.1 ? 0.75 + 2.5 * p : 1 - 0.6 * ((p - 0.1) / 0.9) ** 2);
    const y = wobble * thick * Math.sin(p * Math.PI * 1.3) - lift * Math.max(0, (p - 0.7) / 0.3) ** 2;
    const x = x0 + p * length;
    top.push([x, y - width / 2]);
    bottom.push([x, y + width / 2]);
  }
  const path: PathCmd[] = [["M", top[0]![0] - thick * 0.18, (top[0]![1] + bottom[0]![1]) / 2]];
  for (const [x, y] of top) path.push(["L", x, y]);
  path.push(["L", x0 + length + thick * 0.12, top.at(-1)![1] + (bottom.at(-1)![1] - top.at(-1)![1]) / 2]);
  for (const [x, y] of bottom.reverse()) path.push(["L", x, y]);
  path.push(["Z"]);
  return path;
}

/** The path mirrored about x = 0 (right-to-left cues). */
const mirror = (path: readonly PathCmd[]): PathCmd[] =>
  path.map((cmd): PathCmd => {
    switch (cmd[0]) {
      case "M":
      case "L":
        return [cmd[0], -cmd[1], cmd[2]];
      case "C":
        return ["C", -cmd[1], cmd[2], -cmd[3], cmd[4], -cmd[5], cmd[6]];
      default:
        return cmd;
    }
  });

interface Fragment {
  readonly cell: SpeechCell;
  readonly part: number;
}

interface WordPlan {
  readonly at: number;
  readonly word: SceneWord;
  readonly hero: boolean;
  readonly fragments: Fragment[];
  readonly fill: string;
  readonly onset: number;
  /** Wipe start and end (ms), the first painted frame and the first frame the word is whole. */
  readonly from: number;
  readonly end: number;
  readonly first: number;
  readonly whole: number;
  readonly writes: boolean;
}

export const dripProgram = galleryScene("drip", ANCHOR, (ctx) => {
  const { cue, index, to, bounds } = ctx.window;
  const { fps, rtl, side } = ctx;
  const c = ctx.input.colours;
  const { words } = cue;
  const pieces: Piece[] = [];
  const frame = 1000 / fps;

  // The cue's exit: the sample's 105 ms fade at the end of the window, only with two painted frames.
  const exitFrom = Math.max(ctx.exitAt, to - EXIT);
  const exit = ctx.exit && paintedFrameCount(exitFrom, to, fps) >= 2;
  const decoLimit = exit ? exitFrom : to;
  const fade = (from: number): Frames => (exit && exitFrom > from ? [[from, 1], [exitFrom, 1], [to, 0, "in"]] : [[from, 1]]);

  // Colours as drawn: every word sits in a thin dark keyline, so each keeps 3:1 against it or falls back to the style's own.
  const reads = (colour: string) => captionColourContrast(colour, INK) >= CAPTION_SCENE_BRAND_MIN_CONTRAST;
  const faceFill = reads(c.primary) ? c.primary : WHITE;
  const heroBase = reads(c.highlight) ? c.highlight : TURQUOISE;
  const heroCycle = heroBase.toUpperCase() === TURQUOISE ? [TURQUOISE, LIME] : [heroBase];
  // The offset must show against the face it sits behind.
  const coral = captionColourContrast(c.accent, faceFill) >= 1.5 ? c.accent : CORAL;

  // Counters over the whole clip, so the variants keep cycling however many cues there are.
  const earlier = ctx.input.cues.slice(0, index).filter((other) => other.words.length > 0);
  // The key word: the first hero of the cue (a second hero the scorer picks reads as an ordinary word).
  const heroAt = words.findIndex((word) => word.role === "hero");
  const heroed = heroAt >= 0;
  const ordinal = earlier.filter((other) => hasHero(other) === heroed).length;
  const seed = cueSeed(cue);
  const heroFill = heroCycle[ordinal % heroCycle.length]!;

  // ---- layout: fit each word to the column, break the ones that cannot fit at the floor, the key word on its own row ----
  const at100 = (text: string) => ctx.input.measure(text, FACE, 100 * ctx.space.u, 0).advance / ctx.space.u;
  const chunkAt = (text: string, size: number): string[] => {
    const letters = graphemes(text);
    const split = (room: number): string[] => {
      const out: string[] = [];
      let row = "";
      for (const ch of letters) {
        if (row && at100(row + ch) > room) {
          out.push(row);
          row = "";
        }
        row += ch;
      }
      if (row) out.push(row);
      return out;
    };
    const room = (COLUMN * 0.97 * 100) / size;
    const count = split(room).length;
    // The fewest rows that fit, then the narrowest room that keeps that count: even rows.
    let lo = 0;
    let hi = room;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (split(mid).length <= count) hi = mid;
      else lo = mid;
    }
    return split(hi);
  };
  const arrange = (scale: number) => {
    const flat: { word: number; part: number; text: string; size: number }[] = [];
    const indexes = words.map((word, at) => {
      const hero = at === heroAt;
      const base = (hero ? HERO : heroed ? BODY : SOLO) * scale;
      const floor = hero ? BODY * scale : base * FLOOR;
      const natural = (at100(word.text) * base) / 100;
      const fitted = natural > COLUMN ? (base * COLUMN) / natural : base;
      const cjk = CJK.test(word.text);
      if (natural <= COLUMN || (!cjk && fitted >= floor) || !BREAKABLE.test(word.text)) return [flat.push({ word: at, part: 0, text: word.text, size: fitted }) - 1];
      const chunks = chunkAt(word.text, cjk ? base : floor);
      const widest = Math.max(...chunks.map((chunk) => at100(chunk)));
      const size = clamp((COLUMN * 0.97 * 100) / widest, floor, Math.max(floor, base));
      return chunks.map((text, part) => flat.push({ word: at, part, text, size }) - 1);
    });
    const groups: number[][] = [];
    let run: number[] = [];
    for (const [at, list] of indexes.entries()) {
      if (list.length > 1 || at === heroAt) {
        if (run.length) groups.push(run);
        run = [];
        for (const item of list) groups.push([item]);
      } else run.push(list[0]!);
    }
    if (run.length) groups.push(run);
    const { cells, unit } = ctx.layout({
      column: COLUMN, padding: PAD, gap: GAP, groups,
      words: flat.map((item) => ({ text: item.text, size: item.size, face: FACE, spacing: 0 })),
    });
    return { flat, indexes, cells, u: unit, rows: rowsOf(cells) };
  };
  let plan = arrange(1);
  for (const scale of SCALES) {
    if (plan.rows.length <= 3) break;
    const next = arrange(scale);
    if (next.rows.length < plan.rows.length) plan = next;
  }
  const { indexes, u } = plan;
  // Rows under the key word step down a little so its underline keeps clear of them.
  const heroCells = plan.cells.filter((cell) => plan.flat[cell.at]!.word === heroAt);
  const heroLine = heroCells.length ? Math.max(...heroCells.map((cell) => cell.baseline)) : Number.POSITIVE_INFINITY;
  const heroSize = heroCells.length ? heroCells.at(-1)!.size : 0;
  const cells = plan.cells.map((cell) => (cell.baseline > heroLine ? { ...cell, baseline: cell.baseline + UNDER_ROOM * heroSize } : cell));

  // ---- write-on schedule -------------------------------------------------------------------------------------------
  const plans: WordPlan[] = words.map((word, at) => {
    const fragments = indexes[at]!.map((flatAt, part) => ({ cell: cells.find((item) => item.at === flatAt)!, part }));
    const hero = at === heroAt;
    const start = word.startMs;
    const onset = exportFrameAtOrAfter(Math.max(start, ctx.window.from), fps);
    const lastFrame = Math.max(onset, exportFrameAtOrBefore(word.endMs - 1, fps));
    const from = Math.max(ctx.window.from, start - WRITE_LEAD);
    const end = Math.min(from + WRITE, lastFrame);
    const p = (t: number) => EASES.out(clamp((t - from) / Math.max(1, end - from)));
    // The wipe animates when a fifth of the word is already written on a frame at or before the onset and it has two
    // painted frames before it is whole; otherwise the word prints whole at its onset.
    const times = exportFrameTimes(from, end, fps).filter((t) => p(t) >= 0.2 && p(t) < 0.999);
    const writes = from < onset && times.length >= 2 && times[0]! <= onset;
    const first = writes ? times[0]! : onset;
    const whole = writes ? (exportFrameTimes(end, end + 2 * frame, fps)[0] ?? end) : onset;
    return { at, word, hero, fragments, fill: hero ? heroFill : faceFill, onset, from, end, first, whole, writes };
  });
  const progress = (plan: WordPlan, t: number) => (!plan.writes || t >= plan.end ? 1 : EASES.out(clamp((t - plan.from) / Math.max(1, plan.end - plan.from))));

  // ---- words: one piece each, the coral offset as its own hard shadow, under the moving wipe -----------------------
  for (const plan of plans) {
    for (const { cell, part } of plan.fragments) {
      const size = cell.size;
      const left = cell.x - cell.width / 2;
      const right = cell.x + cell.width / 2;
      const offset = (plan.hero ? HERO_OFFSET : OFFSET) * size;
      const reach = KEYLINE * size + offset + 2;
      const generous: Box = { x1: left - 0.5 * size, x2: right + 0.5 * size, y1: cell.baseline - 1.8 * size, y2: cell.baseline + size };
      const id = plan.fragments.length > 1 ? `${ctx.id}:w${plan.at}l${part}` : `${ctx.id}:w${plan.at}`;
      const face = ctx.face(cell, plan.first, plan.fill);
      const edgeAt = (t: number) => {
        const a = progress(plan, t);
        if (a >= 1) return rtl ? generous.x1 : generous.x2;
        return rtl ? right + reach - a * (cell.width + 2 * reach) : left - reach + a * (cell.width + 2 * reach);
      };
      const wipeTimes = plan.writes ? exportFrameTimes(plan.first, plan.whole, fps) : [];
      let clip: Clip | undefined;
      let lean: Frames | undefined;
      if (wipeTimes.length) {
        const edge: Key[] = [...wipeTimes.map((t) => [t, edgeAt(t)] as Key), [plan.whole, rtl ? generous.x1 : generous.x2]];
        clip = rtl
          ? { x1: edge, x2: [[plan.first, generous.x2]], y1: [[plan.first, generous.y1]], y2: [[plan.first, generous.y2]] }
          : { x1: [[plan.first, generous.x1]], x2: edge, y1: [[plan.first, generous.y1]], y2: [[plan.first, generous.y2]] };
        lean = [...wipeTimes.map((t) => [t, -LEAN * side * (1 - progress(plan, t))] as Key), [plan.whole, 0]];
      }
      pieces.push({
        ...face, id,
        stroke: { widthPx: KEYLINE * size, colour: INK, alpha: 0.7 },
        shadows: [{ dx: offset, dy: offset, blur: 0, colour: coral, alpha: 1 }],
        track: { ...face.track, o: fade(plan.first), ...(lean ? { skx: lean } : {}) },
        ...(clip ? { clip } : {}),
      } satisfies TextPiece);

      // Beat: the brush tip rides the wipe edge behind the lettering, inside its own word's box, and is gone on the frame
      // the word first reads whole.
      const readsWhole = wipeTimes.find((t) => (rtl ? edgeAt(t) <= left - KEYLINE * size + 0.5 : edgeAt(t) >= right + KEYLINE * size - 0.5)) ?? plan.whole;
      const tipTimes = wipeTimes.filter((t) => t < readsWhole);
      if (tipTimes.length >= 2) {
        const top = cell.baseline + cell.inkTop * 0.9;
        const bottom = cell.baseline + Math.min(cell.inkBottom, 0.12 * size);
        const w = 0.1 * size;
        const slant = 0.14 * (bottom - top);
        const tip: PathCmd[] = [
          ["M", -w * 0.35 + slant, top - cell.baseline], ["L", w * 0.35 + slant, top - cell.baseline],
          ["L", w * 0.5, bottom - cell.baseline], ["L", -w * 0.5, bottom - cell.baseline], ["Z"],
        ];
        // The tip's x range in its own word: from half its foot past the leading edge to its slanted top inside the far end.
        const lo = rtl ? left + w * 0.35 + slant : left + w * 0.5;
        const hi = rtl ? right - w * 0.5 : right - w * 0.35 - slant;
        pieces.push({
          ...ctx.shape(`tip${plan.at}${plan.fragments.length > 1 ? `p${part}` : ""}`, plan.first, rtl ? mirror(tip) : tip, {
            x: tipTimes.map((t) => [t, clamp(edgeAt(t) - side * reach * 0.6, Math.min(lo, hi), Math.max(lo, hi))] as Key),
            y: [[plan.first, cell.baseline]],
            o: [[plan.first, 0.92]],
          }, coral),
          z: 5, toMs: readsWhole,
        });
      }
    }
  }

  const faceBox = (cell: SpeechCell, margin: number): Box => ({
    x1: cell.x - cell.width / 2 - margin, x2: cell.x + cell.width / 2 + margin,
    y1: cell.baseline + cell.inkTop - margin, y2: cell.baseline + cell.inkBottom + margin,
  });
  const meets = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
  const keyline = (size: number) => ({ widthPx: Math.max(1.5, 0.02 * size), colour: INK, alpha: 0.55 });
  const margin = 6 * u;
  const inBand = (box: Box) => box.x1 >= bounds.x1 + margin && box.x2 <= bounds.x2 - margin && box.y1 >= bounds.y1 + margin && box.y2 <= bounds.y2 - margin;

  // ---- the key word's beat: a fat coral brush underline that wipes in under it as it is spoken ----------------------
  let underBox: Box | null = null;
  const heroPlan = plans.find((plan) => plan.hero) ?? null;
  if (heroPlan) {
    const cell = heroPlan.fragments.at(-1)!.cell;
    const size = cell.size;
    const variant = ordinal % 3;
    const length = cell.width * (0.8 + 0.14 * seed);
    const thick = Math.max(8 * u, UNDER_T * size);
    const lift = variant === 1 ? 0.45 * thick : 0;
    const wobble = 0.08 * (seed > 0.5 ? 1 : -1);
    const start = cell.x - side * cell.width / 2 + side * cell.width * 0.03;
    const y = cell.baseline + UNDER_Y * size;
    let path: PathCmd[];
    if (variant === 2) {
      const a = length * 0.56;
      const gap = length * 0.08;
      path = [...brushStroke(0, a, thick, 0, wobble), ...brushStroke(a + gap, length - a - gap, thick * 0.82, 0.2 * thick, -wobble)];
    } else path = brushStroke(0, length, thick, lift, wobble);
    if (rtl) path = mirror(path);
    const near = start - side * thick * 0.3;
    const far = start + side * (length + thick * 0.3);
    underBox = { x1: Math.min(near, far), x2: Math.max(near, far), y1: y - thick, y2: y + thick * 0.62 + 0.02 * size };
    const from = Math.max(heroPlan.onset, Math.min(heroPlan.whole, exportFrameAtOrAfter(heroPlan.word.startMs + 20, fps)));
    const dur = Math.min(UNDER_MS, decoLimit - from);
    const moving = paintedFrameCount(from, from + dur, fps) >= 3;
    const at = moving ? from : Math.max(ctx.window.from, Math.min(from, exportFrameAtOrBefore(decoLimit - 2 * frame, fps)));
    if (paintedFrameCount(at, to, fps) >= 2) {
      const box = { y1: y - 2 * thick, y2: y + 2 * thick };
      let clip: Clip | undefined;
      if (moving) {
        const times = exportFrameTimes(from, from + dur, fps);
        const edge: Key[] = [...times.map((t) => [t, near + (far - near) * EASES.out(clamp((t - from) / dur))] as Key), [from + dur, far + side * thick]];
        clip = rtl
          ? { x1: edge, x2: [[from, near + thick]], y1: [[from, box.y1]], y2: [[from, box.y2]] }
          : { x1: [[from, near - thick]], x2: edge, y1: [[from, box.y1]], y2: [[from, box.y2]] };
      }
      pieces.push({
        ...ctx.shape("under", at, path, { x: [[at, start]], y: [[at, y]], o: fade(at) }, coral),
        z: 4, stroke: keyline(size), ...(clip ? { clip } : {}),
      } satisfies ShapePiece);
    }
  }

  // ---- beat: paint flecks flick off the reading end of the cue's last word as it finishes writing -------------------
  {
    const last = plans.at(-1)!;
    const cell = last.fragments.at(-1)!.cell;
    const size = cell.size;
    const count = 2 + ((ordinal + Math.floor(seed * 4)) % 2);
    const radii = [0.085, 0.062, 0.045].map((r) => Math.max(6 * u, r * size));
    const edge = cell.x + side * (cell.width / 2 + (last.hero ? HERO_OFFSET : OFFSET) * size);
    const midY = cell.baseline + cell.inkTop * 0.5;
    const jitter = (seed - 0.5) * 0.1 * size;
    const spots = (kind: "out" | "up") =>
      radii.slice(0, count).map((r, i) => {
        const x = kind === "out"
          ? edge + side * (0.15 + 0.17 * i) * size
          : edge - side * (0.06 + 0.18 * i) * size;
        const y = kind === "out"
          ? midY + [0.02, -0.2, 0.12][i]! * size + jitter
          : cell.baseline + cell.inkTop - (0.14 + [0, 0.1, 0.02][i]!) * size;
        return { x, y, r };
      });
    const heroInk = heroPlan ? Math.max(...heroPlan.fragments.map(({ cell: hero }) => hero.baseline + hero.inkBottom)) : Number.POSITIVE_INFINITY;
    const clear = (spot: { x: number; y: number; r: number }) => {
      const reach = spot.r * 1.15 + keyline(size).widthPx;
      const box = { x1: spot.x - reach, x2: spot.x + reach, y1: spot.y - reach, y2: spot.y + reach };
      return inBand(box) && (last.at > heroAt || box.y2 <= heroInk + 0.2 * HERO * u) && !cells.some((other) => meets(box, faceBox(other, 8 * u))) && !(underBox && meets(box, underBox));
    };
    const chosen = [spots("out"), spots("up")].find((set) => set.every(clear));
    if (chosen) {
      let from = exportFrameAtOrAfter(Math.max(last.whole, last.onset) + 1, fps);
      const animated = paintedFrameCount(from, Math.min(decoLimit, from + FLECK_MS + FLECK_STAGGER * (count - 1)), fps) >= 3 &&
        from + FLECK_MS + FLECK_STAGGER * (count - 1) <= decoLimit;
      if (!animated) from = Math.max(last.onset, Math.min(from, exportFrameAtOrBefore(decoLimit - 2 * frame, fps)));
      chosen.forEach((spot, i) => {
        const at = animated ? exportFrameAtOrAfter(from + i * FLECK_STAGGER, fps) : from;
        const scale: Key[] = animated ? [[at, 0.25], [at + FLECK_MS, 1, "outBack"]] : [[at, 1]];
        const squash = 1 + 0.25 * ((seed * (i + 3)) % 1);
        pieces.push({
          ...ctx.shape(`fleck${i}`, at, ellipsePath(0, 0, spot.r * squash, spot.r), {
            x: [[at, spot.x]], y: [[at, spot.y]], sx: scale, sy: scale, o: fade(at),
          }, i === 1 ? last.fill : coral),
          z: 5, stroke: keyline(size),
        } satisfies ShapePiece);
      });
    }
  }

  return pieces;
}, undefined, LEAD);
