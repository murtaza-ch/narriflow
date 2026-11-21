import { toCaptionUpperCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, fitScale, greedyRows, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { PathCmd, Piece, ShapePiece, Shadow } from "../scene";
import { pathBounds, polylinePath } from "../shapes";

/**
 * Heft (`samples/templates/m14-weight.js`, after Motion Array "Kinetic Typography"): two type voices. Ordinary words are an
 * airy light wide geometric (Lexend Exa Light capitals) typed on one letter at a time by a stepped clip. The key word drops the
 * weight on you: a faded ghost of it rushes in large and blurred, hard-cuts to an ultra-black wide word (Unbounded Black)
 * that stacks two fading echoes below itself, and a lime asterisk spins in at its corner. A cue without a key word stays light
 * and gets lime angle brackets.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`): light words
 * 74 px with a 1.12 line box (baseline 68 px into it, 0.9189 em), 0.01 em letter spacing, 0.42 em apart, wrapped greedily at
 * 760 px; the key word fits 880 px (at most 170 px, baseline 0.8706 em into its `line-height: 1` box, -0.02 em), its stack is
 * `0.84 em x 3 + 0.12 em` tall so the echoes' room is part of the block, 14 px under a lead row and 6 px over a tail; the block
 * is centred on y 1290. The asterisk is six round arms (stroke 15 of a 120 unit box drawn at 0.62 em) centred on the word's
 * top right corner; the brackets are 100 unit polylines scaled to 0.9 of the block's height, 26 px outside the light words.
 *
 * What changed from the sample, and why (the owner's brief for gallery 2):
 *  - Every choice recurs on every cue and cycles. The sample has one asterisk and one pair of brackets; hero cues alternate the
 *    asterisk's corner (the word's end, then its start), its spin direction and start angle, and the ghost's rush side, with a
 *    small seeded jitter on its angle, size and the rush distance; no-hero cues alternate angle brackets and square brackets and
 *    slide them out from the text, then in from beyond it. Each kind has its own counter, so a long clip never replays cue 1.
 *  - Idle motion on a long hold: the asterisk keeps spinning (the sample's), the brackets breathe a few px every 0.9 s
 *    (bounded to 5 px, so nothing leaves the safe area on a 6 s hold).
 *  - Rows fit: a word wider than the column shrinks the cue's light size (0.5 em floor, then to the safe width), the key word
 *    fits the column with a 76 px floor, then the safe width, and the no-hero rows leave room for the brackets. The sample has no
 *    floors and lets a long word run off the frame. Rows and decorations are placed from measured widths on the real canvas.
 *  - Real speech: the typing speed is capped so a word is complete when it has been said (34 ms a letter at most), the key word's
 *    cut comes at half the word's length (160 ms at most), and the cue's exit never starts before the last word has landed and
 *    been readable for 170 ms; a late word lengthens the cue instead of being faded half typed (the exit shortens to 70 ms).
 *  - Scripts that join or have no letter boundaries (Arabic, Urdu, Devanagari, Thai, CJK ...) are not typed letter by letter:
 *    the word is wiped in over the same time, from its reading edge (right to left for RTL). Capitals apply only to cased scripts
 *    (`toCaptionUpperCase`). Right-to-left cues mirror the asterisk's corner and read their rows right to left.
 *  - Only the first key word is heavy, as in the sample; a second key word reads as a light word.
 *  - The sample puts a 14 px margin above a key word with no lead row; that margin is dropped (it only shifted the block).
 *  - The light words draw one of the sample's two text shadows (the soft one); the key word draws both. The tight 1 px one is
 *    invisible under 74 px strokes and costs a blurred layer per word.
 *  - The asterisk and the ghost bleed past the safe area on purpose (spin reach, 1.26x rush); the words never do.
 */

export const HEFT_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m permission",
    "just:b build:h@560",
    "make:b+380 it:m ugly:b first",
    "then:b make:b it:m yours:h@600",
  ],
  options: { rate: 290, cueGap: 160, tail: 850, lead: 350 },
};

const CENTER_Y = 1290;
const MAX_W = 880;
const COLUMN = MAX_W - 120;
const LIGHT = 74;
const LIGHT_FACE = "Lexend Exa Light" as const;
const LIGHT_LS = 0.01;
const LIGHT_GAP_EM = 0.42;
const LINE_EM = 1.12;
const PAD_EM = 0.12;
/** Chrome puts the baseline 68 px into a 74 px, 1.12 line box. */
const LIGHT_BASELINE_EM = 68 / 74;
const HERO_FACE = "Unbounded Black" as const;
const HERO_LS = -0.02;
const HERO_MAX = 170;
const HERO_MIN = 76;
/** The baseline of the key word's `line-height: 1` box: 148 of 170 px. */
const HERO_BASELINE_EM = 148 / 170;
const STEP_EM = 0.84;
const STACK_EM = STEP_EM * 3 + 0.12;
const ECHO = [0.4, 0.15] as const;
const LEAD_GAP = 14;
const TAIL_GAP = 6;
const TYPE_MS = 34;
const TYPE_LEAD = 50;
const EXIT = 140;
const EXIT_MIN = 70;
const EXIT_RISE = 24;
const HOLD = 170;
const GHOST_PRE = 80;
const CUT_MAX = 160;
const SLAM = 160;
const ECHO_EVERY = 150;
const ECHO_SLIDE = 260;
const STAR_POP = 460;
const BRACKET_MS = 460;
const BREATH_MS = 900;
const BREATH_PX = 5;
const STAR_ARMS: readonly PathCmd[] = [
  ["M", 0, -50], ["L", 0, 50],
  ["M", -43.3, -25], ["L", 43.3, 25],
  ["M", -43.3, 25], ["L", 43.3, -25],
];
const STAR_UNITS = 120;
const STAR_STROKE = 15;
/** Half the star's diagonal reach (arm tip plus round cap) in its 120 unit box. */
const STAR_REACH = 57.5 / STAR_UNITS;
const SPRING_PEAK = Math.max(...Array.from({ length: 201 }, (_, at) => EASES.spring(at / 200)));

/** Where a seeded value in 0..1 comes from: FNV-1a of the string, finished with a mulberry step. Same cue, same answer. */
export function heftHash(seed: string, salt = 0): number {
  let h = 0x811c9dc5 ^ salt;
  for (let at = 0; at < seed.length; at++) h = Math.imul(h ^ seed.charCodeAt(at), 0x01000193);
  let x = (h + 0x6d2b79f5) | 0;
  x = Math.imul(x ^ (x >>> 15), 1 | x);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

const SIMPLE_LETTER = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u;

/** True when a word's letters may be revealed one by one: only Latin, Cyrillic and Greek letters (no joining, no clusters). */
export function heftSplitsIntoLetters(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  return letters.every((letter) => SIMPLE_LETTER.test(letter));
}

/** A letter with the combining marks that belong to it. */
const graphemes = (text: string): string[] => text.match(/\P{M}\p{M}*/gu) ?? [text];

/** The sample's letter count at `t`: one letter every 34 ms from 50 ms before the word. */
export function heftTyped(t: number, startMs: number, n: number, stepMs = TYPE_MS): number {
  return t < startMs - TYPE_LEAD ? 0 : Math.min(n, 1 + Math.floor((t - (startMs - TYPE_LEAD)) / stepMs));
}

/** A path drawn from its own top-left with its pivot (local (0, 0)) in `origin`: libass places a drawing by its box. */
function anchored(path: readonly PathCmd[]): { path: PathCmd[]; origin: { dx: number; dy: number } } {
  const box = pathBounds(path);
  const moved = path.map((cmd): PathCmd => {
    if (cmd[0] === "Z") return cmd;
    if (cmd[0] === "C") return ["C", cmd[1] - box.x1, cmd[2] - box.y1, cmd[3] - box.x1, cmd[4] - box.y1, cmd[5] - box.x1, cmd[6] - box.y1];
    return [cmd[0], cmd[1] - box.x1, cmd[2] - box.y1];
  });
  return { path: moved, origin: { dx: -box.x1, dy: -box.y1 } };
}

interface LightWord {
  readonly index: number;
  readonly text: string;
  /** The CSS box: advance plus the trailing letter spacing. */
  readonly width: number;
  readonly letters: boolean;
  /** Right edges of the typed letters from the ink's left, canvas px (letter words only). */
  readonly edges: readonly number[];
  readonly rtlWord: boolean;
  left: number;
  baseline: number;
}

function buildCue(cue: SceneCue, cueNumber: number, seq: number, input: SceneInput): Piece[] {
  const space = sceneSpace(input, CENTER_Y);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const band = cueNumber * 10;
  const seed = `${cue.index}:${cue.words.map((word) => word.text).join(" ")}`;
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const hero = heroAt >= 0 ? cue.words[heroAt]! : null;
  const upper = (text: string) => toCaptionUpperCase(text, cue.language);
  const safeW = space.safe.x2 - space.safe.x1;
  const cx = space.x(540);
  const centreY = space.y(CENTER_Y);
  const pieces: Piece[] = [];

  // ---- the light words: one size for the cue, wrapped greedily, centred ----
  const lightIndices = cue.words.map((_, at) => at).filter((at) => at !== heroAt);
  const lead = hero ? lightIndices.filter((at) => at < heroAt) : lightIndices;
  const tail = hero ? lightIndices.filter((at) => at > heroAt) : [];
  const measureLight = (text: string, size: number) => input.measure(upper(text), LIGHT_FACE, size, LIGHT_LS).advance + LIGHT_LS * size;
  const bracketRoom = hero ? 0 : (0.4 * 100 + 26) * u + 2 * PAD_EM * LIGHT * u;
  let size = LIGHT * u;
  if (lightIndices.length > 0) {
    const widest = Math.max(...lightIndices.map((at) => measureLight(cue.words[at]!.text, size)));
    const column = Math.min(MAX_W * u, safeW - 2 * bracketRoom);
    size *= Math.min(Math.max(fitScale(widest, column), 0.5), fitScale(widest, safeW - 2 * bracketRoom));
  }
  const gap = LIGHT_GAP_EM * size;
  const pitch = LINE_EM * size;
  const arrange = (indices: readonly number[], limit: number) => {
    const widths = indices.map((at) => measureLight(cue.words[at]!.text, size));
    return greedyRows(widths, gap, limit).map((row) => {
      const ordered = rowVisualOrder(row.map((at) => cue.words[indices[at]!]!.text), rtl ? "rtl" : "ltr").map((at) => row[at]!);
      return { indices: ordered.map((at) => indices[at]!), widths: ordered.map((at) => widths[at]!) };
    });
  };
  let limit = Math.min(COLUMN * u, safeW - 2 * bracketRoom);
  let leadRows = arrange(lead, limit);
  const tailRows = arrange(tail, limit);
  const wideRows = (rows: ReturnType<typeof arrange>) => Math.max(0, ...rows.map((row) => rowWidth(row.widths, row.widths.map((_, at) => at), gap)));
  const rowsHeight = (rows: readonly unknown[]) => rows.length * pitch;

  // ---- the key word ----
  let heroSize = 0;
  let heroBox = 0;
  const heroText = hero ? upper(hero.text) : "";
  const heroWidth = (s: number) => input.measure(heroText, HERO_FACE, s, HERO_LS).advance + HERO_LS * s;
  if (hero) {
    // The sample sizes it so the natural word (no letter spacing) fits 880 px; at most 170, whole px.
    const natural = input.measure(heroText, HERO_FACE, 100 * u, 0).advance / u;
    heroSize = Math.max(HERO_MIN, Math.min(HERO_MAX, Math.floor((MAX_W * 100) / natural))) * u;
    // The floor keeps it heavier than the light words; a word that still overruns the safe width shrinks to it.
    heroSize *= fitScale(heroWidth(heroSize), safeW);
    heroBox = heroWidth(heroSize);
  }

  // ---- vertical layout of the block ----
  const heights = (rowsLead: typeof leadRows, rowsTail: typeof tailRows) => {
    const leadH = rowsHeight(rowsLead);
    const tailH = rowsHeight(rowsTail);
    const stackH = hero ? STACK_EM * heroSize : 0;
    return { leadH, tailH, stackH, total: leadH + (hero && rowsLead.length ? LEAD_GAP * u : 0) + stackH + (hero && rowsTail.length ? TAIL_GAP * u : 0) + tailH };
  };
  let h = heights(leadRows, tailRows);
  let bracketH = Math.max(100 * u, 0.9 * h.total);
  if (!hero) {
    // The brackets sit outside the widest row: shrink the wrap until the pair fits the safe width.
    for (let guard = 0; guard < 8; guard++) {
      const room = 0.4 * bracketH + 26 * u + PAD_EM * size;
      const reach = wideRows(leadRows) + 2 * room;
      if (reach <= safeW || limit < size * 2) break;
      limit = Math.max(size * 2, limit - (reach - safeW));
      leadRows = arrange(lead, limit);
      h = heights(leadRows, tailRows);
      bracketH = Math.max(100 * u, 0.9 * h.total);
    }
  }
  const blockTop = centreY - h.total / 2;
  const leadTop = blockTop;
  const stackTop = leadTop + h.leadH + (hero && leadRows.length ? LEAD_GAP * u : 0);
  const tailTop = hero ? stackTop + h.stackH + (tailRows.length ? TAIL_GAP * u : 0) : blockTop;

  const place = (rows: ReturnType<typeof arrange>, top: number): LightWord[] => {
    const out: LightWord[] = [];
    rows.forEach((row, ri) => {
      const total = rowWidth(row.widths, row.widths.map((_, at) => at), gap);
      let x = cx - total / 2;
      row.indices.forEach((index, at) => {
        const raw = cue.words[index]!.text;
        const text = upper(raw);
        const letters = heftSplitsIntoLetters(text);
        const edges = letters ? graphemes(text).map((_, k, all) => (k === all.length - 1 ? row.widths[at]! : input.measure(all.slice(0, k + 1).join(""), LIGHT_FACE, size, LIGHT_LS).advance + LIGHT_LS * size)) : [];
        out.push({ index, text, width: row.widths[at]!, letters, edges, rtlWord: cueDirection({ words: [{ ...cue.words[index]!, text: raw }], language: cue.language }) === "rtl", left: x, baseline: top + ri * pitch + LIGHT_BASELINE_EM * size });
        x += row.widths[at]! + gap;
      });
    });
    return out;
  };
  const lights = [...place(leadRows, leadTop), ...place(tailRows, tailTop)];

  // ---- timing: when each word has landed, then the exit ----
  const typing = new Map<number, { t0: number; step: number; n: number; land: number }>();
  for (const light of lights) {
    const word = cue.words[light.index]!;
    const t0 = word.startMs - TYPE_LEAD;
    const n = light.letters ? light.edges.length : 1;
    if (light.letters) {
      const step = clamp((word.endMs - t0) / Math.max(1, n), 10, TYPE_MS);
      typing.set(light.index, { t0, step, n, land: t0 + (n - 1) * step });
    } else {
      const span = clamp(Math.min([...light.text].length * TYPE_MS, word.endMs - t0), 90, 700);
      typing.set(light.index, { t0, step: span, n: 1, land: t0 + span });
    }
  }
  const heroStart = hero ? hero.startMs : 0;
  let cutAt = heroStart + (hero ? clamp((hero.endMs - hero.startMs) * 0.5, 60, CUT_MAX) : 0);
  const landedAt = () => Math.max(cue.startMs - 40, ...[...typing.values()].map((entry) => entry.land), hero ? cutAt + 40 : 0);
  const base = cue.endMs - 80;
  // The cue never outlives its end (the next cue's start): the exit shortens to 70 ms at the least.
  let exitFrom = Math.min(Math.max(base - EXIT, landedAt() + HOLD), cue.endMs - EXIT_MIN);
  if (landedAt() + 30 > exitFrom) {
    // A word said just before the cue ends: type it faster and cut the key word sooner, so it has landed when the exit starts.
    const limit = exitFrom - 30;
    for (const entry of typing.values()) {
      if (entry.land <= limit) continue;
      if (entry.n > 1) {
        entry.step = Math.max(4, (limit - entry.t0) / (entry.n - 1));
        entry.land = entry.t0 + (entry.n - 1) * entry.step;
      } else {
        entry.step = Math.max(30, limit - entry.t0);
        entry.land = entry.t0 + entry.step;
      }
    }
    if (hero) cutAt = Math.max(heroStart - GHOST_PRE + 30, Math.min(cutAt, limit - 40));
  }
  const exitDur = clamp(Math.min(EXIT, cue.endMs - exitFrom), EXIT_MIN, EXIT);
  exitFrom = Math.min(exitFrom, cue.endMs - exitDur);
  const exitTo = exitFrom + exitDur;
  const outAt = (t: number) => EASES.in(prog(t, exitFrom, exitDur));
  const rise = EXIT_RISE * u;
  const ceilTo = (t: number) => Math.ceil(t);

  /** `[from, rest]` held, then the block's exit: `rest` moved by `delta` over the exit (`in`). */
  const held = (from: number, rest: number, delta: number): Frames => [[from, rest], [exitFrom, rest], [exitTo, rest + delta, "in"]];
  const fade = (from: number): Frames => held(from, 1, -1);
  /** A track that is the piece's own animation (settled at `settle`) times or plus the block's exit. */
  const composed = (own: Frames, ownAt: (t: number) => number, settle: number, rest: number, delta: number, from: number, tolerance: number): Frames => {
    if (settle <= exitFrom) return [...own, [exitFrom, rest], [exitTo, rest + delta, "in"]];
    return sampleFrames(ownAt, [from, settle, exitFrom, exitTo].filter((at) => at >= from).sort((a, b) => a - b), tolerance);
  };

  // ---- the light words ----
  const shadows = (scale: number): Shadow[] => [
    { dx: 0, dy: 3 * u * scale, blur: 7 * u * scale, colour: "#000000", alpha: 0.75 },
    { dx: 0, dy: 1 * u * scale, blur: 1 * u * scale, colour: "#000000", alpha: 0.6 },
  ];
  const lightShadows: Shadow[] = shadows(1).slice(0, 1);
  for (const light of lights) {
    const entry = typing.get(light.index)!;
    const rowTop = light.baseline - LIGHT_BASELINE_EM * size;
    const padPx = PAD_EM * size;
    const common = {
      kind: "text" as const,
      z: band + 5,
      text: light.text,
      face: LIGHT_FACE,
      sizePx: size,
      letterSpacingEm: LIGHT_LS,
      fill: input.colours.primary,
      shadows: lightShadows,
      anchor: "baseline-left" as const,
      language: cue.language,
    };
    const t1 = Math.round(entry.t0);
    const land = light.letters && entry.n === 1 ? t1 : Math.round(entry.land);
    const inkLeft = light.left;
    const inkRight = light.left + light.width;
    const y1 = rowTop - 0.15 * size;
    const y2 = rowTop + (LINE_EM + 0.1) * size;
    if (land > t1) {
      let x1: Frames;
      let x2: Frames;
      if (light.letters) {
        // Hard steps: the clip's right edge jumps to each letter's right edge, one a step.
        const times = Array.from({ length: entry.n }, (_, k) => Math.round(entry.t0 + k * entry.step));
        const frames: [number, number][] = [[times[0]!, inkLeft + light.edges[0]!]];
        for (let k = 1; k < entry.n; k++) {
          if (times[k]! <= frames[frames.length - 1]![0]) continue;
          frames.push([times[k]! - 1, frames[frames.length - 1]![1]], [times[k]!, inkLeft + light.edges[k]!]);
        }
        x1 = [[t1, inkLeft - padPx]];
        x2 = frames;
      } else if (light.rtlWord) {
        x1 = [[t1, inkRight + padPx], [land, inkLeft - padPx]];
        x2 = [[t1, inkRight + padPx]];
      } else {
        x1 = [[t1, inkLeft - padPx]];
        x2 = [[t1, inkLeft - padPx], [land, inkRight + padPx]];
      }
      pieces.push({
        ...common,
        id: `heft:${cueNumber}:w${light.index}`,
        fromMs: t1,
        toMs: land,
        track: { x: [[t1, inkLeft]], y: [[t1, light.baseline]] },
        clip: { x1, x2, y1: [[t1, y1]], y2: [[t1, y2]] },
      });
    }
    // Typed: the word rests under the block's exit.
    pieces.push({
      ...common,
      id: `heft:${cueNumber}:w${light.index}r`,
      fromMs: land,
      toMs: exitTo,
      track: { x: [[land, inkLeft]], y: held(land, light.baseline, -rise), o: fade(land) },
    });
  }

  // ---- the key word: ghost rush, hard cut, echoes, asterisk ----
  if (hero) {
    const pivotY = stackTop + heroSize / 2;
    const baselineY = stackTop + HERO_BASELINE_EM * heroSize;
    const left = cx - heroBox / 2;
    const origin = { dx: heroBox / 2, dy: pivotY - baselineY };
    const flip = seq % 2 === 0 ? 1 : -1;
    const side = (rtl ? -1 : 1) * flip;
    const face = {
      kind: "text" as const,
      text: heroText,
      face: HERO_FACE,
      sizePx: heroSize,
      letterSpacingEm: HERO_LS,
      fill: input.colours.highlight,
      anchor: "baseline-left" as const,
      language: cue.language,
    };

    // Ghost: a faded copy rushing in from the side, shrinking onto the word, sharpening as it goes.
    const gFrom = heroStart - GHOST_PRE;
    const rush = (24 + 8 * heftHash(seed, 1)) * u * side;
    pieces.push({
      ...face,
      id: `heft:${cueNumber}:ghost`,
      z: band + 3,
      fromMs: Math.max(cue.startMs - 60, gFrom + 4),
      toMs: ceilTo(cutAt),
      bleed: true,
      track: {
        x: [[gFrom, cx + rush], [cutAt, cx, "out"]],
        y: [[gFrom, pivotY]],
        sx: [[gFrom, 1.26], [cutAt, 1, "out"]],
        sy: [[gFrom, 1.26], [cutAt, 1, "out"]],
        o: [[gFrom, 0.42], [cutAt, 0.72]],
        blur: [[gFrom, 10 * u], [cutAt, 0, "out"]],
      },
      origin,
    });

    // The hard cut to the solid word, slamming from 1.06x.
    pieces.push({
      ...face,
      id: `heft:${cueNumber}:hero`,
      z: band + 2,
      fromMs: ceilTo(cutAt),
      toMs: exitTo,
      track: {
        x: [[cutAt, cx]],
        y: held(cutAt, pivotY, -rise),
        sx: [[cutAt, 1.06], [cutAt + SLAM, 1, "outExpo"]],
        sy: [[cutAt, 1.06], [cutAt + SLAM, 1, "outExpo"]],
        o: fade(cutAt),
      },
      origin,
      shadows: shadows(1),
    });

    // Two echoes stack down 150 ms apart and fold back into the word on exit.
    ECHO.forEach((opacity, i) => {
      const at = cutAt + (i + 1) * ECHO_EVERY;
      const reach = (i + 1) * STEP_EM * heroSize;
      const settle = at + ECHO_SLIDE;
      const from = ceilTo(at);
      if (from >= exitTo) return;
      const ownAt = (t: number) => {
        const p = EASES.outExpo(prog(t, at, ECHO_SLIDE));
        return baselineY + reach * lerp(0.6, 1, p) * (1 - outAt(t)) - rise * outAt(t);
      };
      pieces.push({
        ...face,
        id: `heft:${cueNumber}:echo${i}`,
        z: band + 1,
        fromMs: from,
        toMs: exitTo,
        track: {
          x: [[from, left]],
          y: composed([[at, baselineY + 0.6 * reach], [settle, baselineY + reach, "outExpo"]], ownAt, settle, baselineY + reach, -reach - rise, from, 0.25),
          o: [[from, opacity], [exitFrom, opacity], [exitTo, 0, "in"]],
        },
      });
    });

    // The asterisk: on the word's top corner, popping with a spring while it turns; it keeps spinning for the whole hold.
    const k = (0.62 * heroSize) / STAR_UNITS;
    const radius = STAR_REACH * 0.62 * heroSize * SPRING_PEAK;
    // The sample puts it at the word's end (+0.04 em), no further than 0.2 em short of x 1000; the flipped cue puts it at the start.
    const edge = (heroBox / 2 + 0.04 * heroSize) * side;
    const limitX = (460 - 0.2 * heroSize / u) * u;
    const centreX = clamp(cx + clamp(edge, -limitX, limitX), space.safe.x1 + radius, space.safe.x2 - radius);
    const starY = stackTop + 0.01 * heroSize;
    const sp = cutAt + 100;
    const spinSign = flip * (rtl ? -1 : 1);
    const start = (-120 + (heftHash(seed, 2) - 0.5) * 24) * spinSign;
    const spin = (0.03 + 0.012 * (heftHash(seed, 3) - 0.5)) * spinSign;
    const growth = 0.92 + 0.16 * heftHash(seed, 4);
    const scale = (t: number) => (t < sp ? 0 : EASES.spring(prog(t, sp, STAR_POP)));
    const popFrom = ceilTo(sp) + 4;
    const turn = (t: number) => lerp(start, 0, scale(t)) + spin * Math.max(0, t - sp);
    const popEnd = sp + STAR_POP;
    const rz: Frames = popEnd < exitTo
      ? [...sampleFrames(turn, [sp, popEnd], 0.3), [exitTo, turn(exitTo)]]
      : sampleFrames(turn, [sp, exitTo], 0.3);
    const star = anchored(
      STAR_ARMS.map((cmd): PathCmd => (cmd[0] === "Z" ? cmd : [cmd[0], (cmd[1] as number) * k * growth, (cmd[2] as number) * k * growth] as PathCmd)),
    );
    if (popFrom < exitTo)
      pieces.push({
      id: `heft:${cueNumber}:star`,
      kind: "shape",
      z: band + 4,
      fromMs: popFrom,
      toMs: exitTo,
      bleed: true,
      track: {
        x: [[popFrom, centreX]],
        y: held(popFrom, starY, -rise),
        sx: [[sp, 0], [popEnd, 1, "spring"]],
        sy: [[sp, 0], [popEnd, 1, "spring"]],
        rz,
        o: fade(popFrom),
      },
      origin: star.origin,
      path: star.path,
      stroke: { widthPx: STAR_STROKE * k * growth, colour: input.colours.accent },
      shadows: [{ dx: 0, dy: 3 * u, blur: 4 * u, colour: "#000000", alpha: 0.5 }],
    } satisfies ShapePiece);
  } else if (lights.length > 0) {
    // ---- no key word: lime brackets around the light block ----
    const boxLeft = Math.min(...lights.map((light) => light.left)) - PAD_EM * size;
    const boxRight = Math.max(...lights.map((light) => light.left + light.width)) + PAD_EM * size;
    const sc = bracketH / 100;
    const square = seq % 2 === 1;
    const outward = Math.floor(seq / 2) % 2 === 0;
    const b0 = cue.startMs - 40;
    const from = ceilTo(b0) + 4;
    const open = (t: number) => EASES.outExpo(prog(t, b0, BRACKET_MS));
    for (const sideSign of [-1, 1] as const) {
      const svgLeft = sideSign < 0 ? boxLeft - 0.4 * bracketH - 26 * u : boxRight + 26 * u;
      const mid = svgLeft + 0.2 * bracketH;
      const pts: [number, number][] = square
        ? sideSign < 0 ? [[34, 4], [6, 4], [6, 96], [34, 96]] : [[6, 4], [34, 4], [34, 96], [6, 96]]
        : sideSign < 0 ? [[36, 4], [6, 50], [36, 96]] : [[4, 4], [34, 50], [4, 96]];
      const drawn = anchored(polylinePath(pts.map(([x, y]) => [(x - 20) * sc, (y - 50) * sc] as [number, number])));
      const slide = -sideSign * 60 * u * (outward ? 1 : -1);
      const settle = b0 + BRACKET_MS;
      // After the entrance the pair breathes a few px outward and back, bounded, until the exit.
      const x: [number, number, ("outExpo" | "inOut")?][] = [[b0, mid + slide], [settle, mid, "outExpo"]];
      for (let at = settle + 600, j = 1; at + BREATH_MS <= exitFrom; at += BREATH_MS, j++) {
        if (j === 1) x.push([at, mid]);
        x.push([at + BREATH_MS, mid + sideSign * BREATH_PX * u * (j % 2 === 1 ? 1 : -1), "inOut"]);
      }
      pieces.push({
        id: `heft:${cueNumber}:br${sideSign < 0 ? "L" : "R"}`,
        kind: "shape",
        z: band + 5,
        fromMs: from,
        toMs: exitTo,
        track: {
          x,
          y: held(from, centreY, -rise),
          o: composed([[b0, 0], [settle, 1, "outExpo"]], (t) => open(t) * (1 - outAt(t)), settle, 1, -1, from, 0.01),
        },
        origin: drawn.origin,
        path: drawn.path,
        stroke: { widthPx: 6 * sc, colour: input.colours.accent },
        shadows: [{ dx: 0, dy: 2 * u, blur: 3 * u, colour: "#000000", alpha: 0.6 }],
      } satisfies ShapePiece);
    }
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const heftProgram: SceneProgram = {
  build(input) {
    // Hero cues and plain cues each count their own, so the variants cycle however the clip's cues fall.
    let heroSeq = 0;
    let plainSeq = 0;
    return {
      pieces: input.cues.flatMap((cue, number) => {
        if (cue.words.length === 0) return [];
        const seq = cue.words.some((word) => word.role === "hero") ? heroSeq++ : plainSeq++;
        return buildCue(cue, number, seq, input);
      }),
    };
  },
};
