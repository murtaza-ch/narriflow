import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import { captionTextClusters } from "@narriflow/caption-fonts/caption-block";
import { SAFE_INSET, balancedRows } from "../layout";
import type { PathCmd, Piece, TextPiece, Track } from "../scene";
import { ellipsePath, roundedRectPath, sparklePath } from "../shapes";
import { galleryScene, rowsOf } from "./gallery-layout";

/**
 * Broadway (`samples/templates/m63-broadway.js`, gallery 5): every cue is lit on a theatre marquee. A dark sign with a
 * brass-black frame grows around the words as they are spoken, a ring of round bulbs chases clockwise around it with a
 * fading tail, and when the key word lands, set big in gold, every bulb flashes together. The sign shuts off on exit.
 *
 * Changes from the sample, and why:
 * - **The sign grows with the real words (owner brief).** The sample fits its key word to a 700 px column. Here the key word
 *   is fitted to the widest column the safe area allows (the frame included) and body rows wrap at the sample's 700, so a long
 *   word or a full row makes the sign wider instead of making the letters small. Only a cue wider or taller than the safe
 *   area shrinks, as a whole, like every style.
 * - **Bulbs and frame never touch a word.** The ring sits in the frame band, outside the sample's 80 px of padding; row
 *   heights come from the measured ink (Devanagari is taller than Latin caps), so the sign grows for them as well.
 * - **The ring is cheap and stays on the rim.** The sample re-spaces the ring from the live panel size every frame, so bulbs hop
 *   along it when the count changes. Here a ring is laid out for each size the sign has (corner bulbs, even spacing, at most 24
 *   bulbs) and drawn as a few strips per side (dark brass dots, and cream cores with their halo as a border, one set per third of
 *   the chase; 1 of every 3 is dark, as in the sample). While the sign grows, the old ring stretches with it and the new one
 *   fades in once the frame has nearly arrived, so bulbs never sit on a word. A ring drawn as sign-sized pieces, or as a piece
 *   per bulb, cost over 1.5x Headline; this one is the cheap shape.
 * - **The sign leads the words (review).** It starts growing 160 ms before the word that needs the room is first painted (the
 *   slide is shortened to arrive by then), words open and shut with the sign, a word that arrives is pinned to the row it joins,
 *   and a word's largest pop stays 0.6 padding inside the plate: the plate holds every word's whole ink on every painted frame.
 * - **Long CJK text wraps (review).** Han, kana and Hangul runs break between characters at valid line breaks (never a row that
 *   starts with a closing mark or ends with an opening one) before any shrink, like Latin words that are too long.
 * - **Short windows get still beats (review).** A cue window under 240 ms (a 70 ms word at a zero gap) draws its sweep and glint
 *   as still poses on every frame; a window under 134 ms draws the glint still.
 * - **The sweeps keep the plate dark enough (review).** Both are fixed colours at low alpha (white 0.14, gold 0.16), so the lightest
 *   the plate gets under a word stays inside the 3:1 bar the brand `readsOn` entries read against.
 * - **Hero pop stays on the plate.** The sample's 1.3x start would run past the frame for a wide key word; it starts as large
 *   as the plate and the safe area allow (at most 1.3x). The panel's own spring overshoot is trimmed to about 4%.
 * - **The exit waits for the speech.** It starts once the last word has been readable for 150 ms and is the sample's 190 ms
 *   shut-off, shortened when the next cue is sooner (a hard cut when there is no room). The sample's frozen dim bulbs are gone:
 *   bulbs fade out with the sign.
 * - **Cheap sign.** The frame's two box-shadows are dropped (the near-black frame stands out on its own), the frame is four rim
 *   strips with a 21 px corner (libass pays for a piece by its whole bitmap, so one sign-sized rectangle behind the plate costs
 *   a lot), the plate's gold line is four thin rules, and only the key word glows (one blurred shadow).
 * - Extra recurring beats, none on a word: (1) a soft light sweep that crosses the plate under the words as the sign opens, and
 *   again in gold when the key word lands; (2) a pair of glints on diagonal frame corners when the last word arrives; (3) on
 *   key-word cues, short gold rays burst from the frame while the bulbs flash. Corners, angles and lengths come from a hash of
 *   the cue; rays are skipped where the safe area leaves no room.
 */
export const BROADWAY_DEMO: DemoScript = {
  lines: [
    "ladies:b and:m gentlemen:b",
    "your:m time:b to:m shine:h@700",
    "no:b second:b takes:b",
    "lights:b camera:b action:h@660",
    "take:b a:m bow:h@640",
  ],
  options: { rate: 285, cueGap: 150, tail: 820, lead: 380 },
};

const FACE: TextPiece["face"] = "Bebas Neue";
const SPACING = 0.02;
const BODY = 138;
const HERO_MAX = 250;
const MAX_ROW = 700;
const HERO_ROW = 800;
const FRAME_W = 40;
const PAD_X = 40;
const PAD_Y = 30;
const MIN_PANEL_W = 330;
const BULB_PITCH = 60;
const BULB_R = 9;
const MAX_BULBS = 24;
const STEP_MS = 90;
/** The longest a slide (the sign growing, the words re-centring) takes; it is shortened to reach 99 % by the time the word that needs the room is first painted. */
const SLIDE = 320;
const WORD_LEAD = 70;
/** Scripts a word may be broken inside without breaking its shaping: cased scripts and the no-space CJK scripts. */
const SIMPLE = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}\p{P}\p{S}]+$/u;
/** CJK line breaking: a row never starts with a closing mark or the prolonged-sound mark, nor ends with an opening one. */
const NO_START = /^[\p{Pe}\p{Pf}\p{Po}\u30FC\u3005\u309D\u309E]/u;
const NO_END = /^[\p{Ps}\p{Pi}]$/u;
/** The sign starts to grow this long before the word that needs the room is first painted. */
const GROW_LEAD = 160;
/** A word that would have to shrink below this size (sample px, about half the body size) breaks over several rows instead. */
const MIN_SIZE = 70;
const FLASH = [0, 110, 190, 300, 380, 490, 560] as const;

const PLATE = "#33101B";
const FRAME = "#1B0E0A";
const RULE = "#C9993F";
const BULB_OFF = "#6A4727";
const GLOW = "#FFBE50";

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
const rand = (key: number, salt: number) => hash(`${key}:${salt}`) / 4294967296;

interface Unit {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly w100: number;
  /** Sample px, fitted to its row. */
  readonly size: number;
}

export const broadwayProgram = galleryScene("broadway", 1290, (ctx) => {
  const { cue, index, to } = ctx.window;
  const c = ctx.input.colours;
  const measure = ctx.input.measure;
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const hasHero = heroAt >= 0;

  const safe = ctx.space.safe;
  const margin = 3;
  // The caption band: from 22 % of the canvas above the anchor line to 19 % below it (860 to 1650 of 1920 at the default position).
  const anchorY = ctx.space.y(1290);
  const bandTop = Math.max(safe.y1 + margin, anchorY - (430 * ctx.space.canvas.height) / 1920);
  const bandBottom = Math.min(safe.y2 - margin, anchorY + (360 * ctx.space.canvas.height) / 1920);
  const width100 = cue.words.map((word) => measure(word.text, FACE, 100, SPACING).advance);

  /** The whole layout at text scale `f` (1 = the sample's sizes): units, rows, every visible stack and the sign's size. */
  const plan = (f: number) => {
    const gapSample = BODY * 0.2 * f;
    // A word that would shrink below MIN_SIZE breaks over several rows (never a hyphen: every piece is spoken text).
    const units = cue.words.flatMap((word, wi): Unit[] => {
      const hero = word.role === "hero";
      const natural = (hero ? HERO_MAX : BODY) * f;
      const rowMax = HERO_ROW * (hero ? 0.98 : 1);
      const clusters = SIMPLE.test(word.text) ? captionTextClusters(word.text) : [word.text];
      const floor = Math.min(natural, MIN_SIZE);
      const fitted = (rowMax / Math.max(1, width100[wi]!)) * 100;
      const parts = clusters.length > 1 && fitted < floor ? Math.min(clusters.length, Math.ceil((floor * width100[wi]!) / (100 * rowMax))) : 1;
      // Equal pieces, each cut moved on until it respects the line-breaking rules above.
      const cuts = [0];
      for (let p = 1; p < parts; p++) {
        let cut = Math.max(cuts.at(-1)! + 1, Math.round((p * clusters.length) / parts));
        while (cut < clusters.length - 1 && (NO_START.test(clusters[cut]!) || NO_END.test(clusters[cut - 1]!))) cut++;
        if (cut < clusters.length) cuts.push(cut);
      }
      cuts.push(clusters.length);
      const pieces = cuts.slice(0, -1).map((from, at) => (parts === 1 ? word.text : clusters.slice(from, cuts[at + 1]).join(""))).filter((text) => text.length > 0);
      return pieces.map((text, part) => {
        const w100 = pieces.length === 1 ? width100[wi]! : measure(text, FACE, 100, SPACING).advance;
        return { word: wi, part, parts: pieces.length, text, w100, size: Math.min(natural, (rowMax / Math.max(1, w100)) * 100) };
      });
    });
    const widths = units.map((unit) => (unit.w100 * unit.size) / 100);
    // Key words and broken words stand alone; the words between them wrap into balanced rows of at most 700.
    const groups: number[][] = [];
    let run: number[] = [];
    const flush = () => {
      for (const row of balancedRows(run.map((at) => widths[at]!), gapSample, MAX_ROW)) groups.push(row.map((k) => run[k]!));
      run = [];
    };
    units.forEach((unit, at) => {
      if (cue.words[unit.word]!.role === "hero" || unit.parts > 1) {
        flush();
        groups.push([at]);
      } else run.push(at);
    });
    flush();

    const { cells, unit: px } = ctx.layout({
      column: HERO_ROW, gap: gapSample, padding: (FRAME_W + PAD_X + 32) * f, groups,
      words: units.map((unit) => ({ text: unit.text, face: FACE, size: unit.size, spacing: SPACING })),
    });
    const u = px * f;
    const rows = rowsOf(cells);
    const cellAt = new Map(cells.map((cell) => [cell.at, cell]));
    const rowOfUnit = new Map<number, number>();
    rows.forEach((row, r) => { for (const cell of row) rowOfUnit.set(cell.at, r); });
    const mid = new Map(cells.map((cell) => [cell.at, (cell.inkTop + cell.inkBottom) / 2]));
    const gapPx = gapSample * px;
    const rowGap = 20 * u;
    const up = rows.map((row) => Math.max(1, ...row.map((cell) => -cell.inkTop)));
    const down = rows.map((row) => Math.max(0, ...row.map((cell) => cell.inkBottom)));
    // The sign once word k has been spoken: where every shown unit sits (from the sign's centre) and the sign's size.
    const target = cue.words.map((_, k) => {
      const pos = new Map<number, { x: number; y: number }>();
      const shown = rows.map((row, r) => ({ row: row.filter((cell) => units[cell.at]!.word <= k), r })).filter(({ row }) => row.length > 0);
      const height = shown.reduce((sum, { r }) => sum + up[r]! + down[r]!, 0) + rowGap * (shown.length - 1);
      let top = -height / 2;
      let content = 0;
      for (const { row, r } of shown) {
        const total = row.reduce((sum, cell) => sum + cell.width, 0) + gapPx * (row.length - 1);
        content = Math.max(content, total);
        let x = -total / 2;
        for (const cell of row) {
          pos.set(cell.at, { x: x + cell.width / 2, y: top + up[r]! + mid.get(cell.at)! });
          x += cell.width + gapPx;
        }
        top += up[r]! + down[r]! + rowGap;
      }
      return { pos, pw: Math.max(MIN_PANEL_W * u, content + 2 * (FRAME_W + PAD_X) * u), ph: height + 2 * (FRAME_W + PAD_Y) * u };
    });
    return { units, cellAt, rowOfUnit, mid, target, u, last: target[cue.words.length - 1]! };
  };

  // Overlapping speakers share the band in lanes: cap the text at what a lane holds so both captions are readable and
  // alike in size (a lone short caption does not stay huge beside a shrunken tall one).
  const fullHeight = ctx.space.canvas.height * (1 - 2 * SAFE_INSET);
  const lane = (safe.y2 - safe.y1) / fullHeight;
  let fit = lane < 0.8 ? Math.min(1, (lane * fullHeight * 0.17) / (BODY * ctx.space.u)) : 1;
  let P = plan(fit);
  // Fit the sign to the band (with the pop's 5 % overshoot): a tall cue wraps into fewer rows at smaller text.
  for (let tries = 0; tries < 6 && P.last.ph * 1.05 > bandBottom - bandTop; tries++) {
    fit *= Math.max(0.3, ((bandBottom - bandTop) / (P.last.ph * 1.05)) * 0.985);
    P = plan(fit);
  }
  const { units, cellAt, rowOfUnit, mid, target, u, last } = P;
  const frameW = FRAME_W * u;
  const pwF = last.pw;
  const phF = last.ph;
  const fitX = (pwF / 2) * 1.05;
  const fitY = (phF / 2) * 1.05;
  const cx = clamp(ctx.space.x(540), safe.x1 + margin + fitX, Math.max(safe.x1 + margin + fitX, safe.x2 - margin - fitX));
  const cy = clamp(anchorY, bandTop + fitY, Math.max(bandTop + fitY, bandBottom - fitY));

  // When each word appears. Everything already shown slides by one displacement and a unit that arrives starts that same
  // displacement away from its final place, so words never move relative to one another within a row, nor rows to each
  // other (nothing arriving overlaps a readable word). Each slide starts from where the unit actually is.
  const enters = cue.words.map((word) => ctx.enter(word, word.role === "hero" ? 420 : 260, WORD_LEAD));
  const steps = enters.map((enter) => enter.from);
  // The sign leads the words: it starts growing GROW_LEAD ms before the word that needs the room is first painted, so the
  // plate already holds the word's whole ink (and a row it pushes aside has already moved) on that first frame.
  const grow: number[] = [];
  for (const [k, at] of steps.entries()) grow.push(k === 0 ? at : Math.max(at - GROW_LEAD, grow[k - 1]!));
  const slide = steps.map((at, k) => (k === 0 ? SLIDE : clamp((at - grow[k]!) / 0.7, 100, SLIDE)));
  const startPos: Map<number, { x: number; y: number }>[] = [];
  const startSize: { pw: number; ph: number }[] = [];
  cue.words.forEach((_, k) => {
    const out = new Map<number, { x: number; y: number }>();
    const old: number[] = [];
    if (k === 0) startSize.push({ pw: target[0]!.pw, ph: target[0]!.ph });
    else {
      const e = EASES.outExpo(prog(grow[k]!, grow[k - 1]!, slide[k - 1]!));
      for (const [i] of target[k - 1]!.pos) {
        const before = startPos[k - 1]!.get(i)!;
        const was = target[k - 1]!.pos.get(i)!;
        out.set(i, { x: lerp(before.x, was.x, e), y: lerp(before.y, was.y, e) });
        old.push(i);
      }
      const was = startSize[k - 1]!;
      startSize.push({ pw: lerp(was.pw, target[k - 1]!.pw, e), ph: lerp(was.ph, target[k - 1]!.ph, e) });
    }
    for (const [i, at] of target[k]!.pos) {
      if (out.has(i)) continue;
      const ref = old.find((j) => rowOfUnit.get(j) === rowOfUnit.get(i)) ?? old[0];
      if (ref === undefined) out.set(i, at);
      else {
        const sameRow = rowOfUnit.get(ref) === rowOfUnit.get(i);
        // Pinned to the row it joins, but never past the safe area (a faint start must not push the whole cue smaller).
        const limit = Math.min(cx - safe.x1, safe.x2 - cx) - margin - cellAt.get(i)!.width / 2;
        const pinned = at.x - target[k]!.pos.get(ref)!.x + out.get(ref)!.x;
        out.set(i, { x: sameRow ? clamp(pinned, -Math.max(0, limit), Math.max(0, limit)) : at.x, y: at.y - target[k]!.pos.get(ref)!.y + out.get(ref)!.y });
      }
    }
    startPos.push(out);
  });
  const stepAt = (t: number) => {
    let k = 0;
    for (let s = 0; s < grow.length; s++) if (t >= grow[s]!) k = s;
    return k;
  };
  const position = (i: number, t: number) => {
    const k = Math.max(units[i]!.word, stepAt(t));
    const e = EASES.outExpo(prog(t, grow[k]!, slide[k]!));
    const from = startPos[k]!.get(i)!;
    const at = target[k]!.pos.get(i)!;
    return { x: lerp(from.x, at.x, e), y: lerp(from.y, at.y, e) };
  };
  // The sign's size and pop are asked for by every bulb at the same instants: remember the last answers.
  const memo = <T,>(fn: (t: number) => T) => {
    const seen = new Map<number, T>();
    return (t: number): T => {
      let value = seen.get(t);
      if (value === undefined) {
        value = fn(t);
        seen.set(t, value);
      }
      return value;
    };
  };
  const size = memo((t: number) => {
    const k = stepAt(t);
    const e = EASES.outExpo(prog(t, grow[k]!, slide[k]!));
    return { pw: lerp(startSize[k]!.pw, target[k]!.pw, e), ph: lerp(startSize[k]!.ph, target[k]!.ph, e) };
  });

  // The sign's life: it opens with the first word (spring, trimmed overshoot) and shuts off on exit.
  const first = enters[0]!;
  const panelFrom = first.from;
  const openFor = clamp(2 * (first.settled - first.from), 134, 380);
  const exitFor = Math.max(1, to - ctx.exitAt);
  const leave = (t: number) => (ctx.exit ? EASES.in(prog(t, ctx.exitAt, exitFor)) : 0);
  const open = (t: number) => prog(t, panelFrom, openFor);
  // Fast speech (a first word under about 130 ms) gets a compact pose: the sign is already close to size and solid on the
  // first painted word, so it is never a faint small box behind a readable word.
  const slow = clamp((first.settled - first.from - 200) / 160);
  const popFrom = lerp(0.92, 0.6, slow);
  const aliveFrom = lerp(0.95, 0.4, slow);
  const popScale = memo((t: number) => {
    const spring = EASES.spring(open(t));
    return lerp(popFrom, 1, spring <= 1 ? spring : 1 + (spring - 1) * 0.35) * (1 - 0.1 * leave(t));
  });
  const alive = (t: number) => lerp(aliveFrom, 1, clamp((t - panelFrom) / 45)) * (1 - leave(t));
  const edges = [panelFrom, panelFrom + openFor, ...grow, ...grow.map((s, k) => s + slide[k]!), ctx.exitAt, to];
  const frames = (fn: (t: number) => number, tolerance: number, a = panelFrom, b = to, extra: number[] = []) =>
    sampleFrames(fn, [...edges, ...extra], tolerance, { range: [a, Math.max(b, a + 1)], simplify: true });
  const exitBound = ctx.exit ? ctx.exitAt : to;

  const pieces: Piece[] = [];
  const inset = 2 * frameW;
  const innerW = pwF - inset;
  const innerH = phF - inset;
  const hold = (value: number): Frames => [[panelFrom, value]];

  // The sign: frame and plate grow with the words.
  // The brass-black frame is four rim pieces, not one big rounded rectangle behind the plate: libass pays for a piece by its whole
  // bitmap, and a sign-sized rectangle is the dearest thing on screen. The strips run a little under the plate so no seam shows.
  const lap = 2 * u;
  const radius = Math.min(40 * u, frameW);
  const rim = (name: string, horizontal: boolean, towards: number) => {
    const thick = frameW + lap;
    const length = horizontal ? pwF : phF - 2 * frameW + 2 * lap;
    const path = horizontal
      ? roundedRectPath(-length / 2, -thick / 2, length, thick, towards < 0 ? [radius, radius, 0, 0] : [0, 0, radius, radius])
      : roundedRectPath(-thick / 2, -length / 2, thick, length, 0);
    const place = (t: number) => {
      const { pw, ph } = size(t);
      return ((horizontal ? ph : pw) / 2 - thick / 2) * towards;
    };
    const stretch = (t: number) => {
      const { pw, ph } = size(t);
      return (popScale(t) * (horizontal ? pw : ph - 2 * frameW + 2 * lap)) / length;
    };
    const shape = ctx.shape(name, panelFrom, path, {
      x: horizontal ? hold(cx) : frames((t) => cx + popScale(t) * place(t), 0.15),
      y: horizontal ? frames((t) => cy + popScale(t) * place(t), 0.15) : hold(cy),
      sx: horizontal ? frames(stretch, 0.003) : frames(popScale, 0.003),
      sy: horizontal ? frames(popScale, 0.003) : frames(stretch, 0.003),
      o: frames(alive, 0.004),
    }, FRAME);
    pieces.push({ ...shape, z: 1 });
  };
  rim("sign-top", true, -1);
  rim("sign-bottom", true, 1);
  rim("sign-left", false, -1);
  rim("sign-right", false, 1);
  const plate = ctx.shape("plate", panelFrom, roundedRectPath(-innerW / 2, -innerH / 2, innerW, innerH, 14 * u), {
    x: hold(cx), y: hold(cy),
    sx: frames((t) => (popScale(t) * (size(t).pw - inset)) / innerW, 0.003), sy: frames((t) => (popScale(t) * (size(t).ph - inset)) / innerH, 0.003),
    o: frames(alive, 0.004),
  }, PLATE);
  pieces.push({ ...plate, z: 2 });
  // The gold line round the plate is four thin rules (a stroke on the plate would double its bitmap, the biggest on screen).
  const rule = 3 * u;
  const ruleSide = (name: string, horizontal: boolean, towards: number) => {
    const length = (horizontal ? innerW : innerH) - 2 * rule;
    const path = roundedRectPath(horizontal ? -length / 2 : -rule / 2, horizontal ? -rule / 2 : -length / 2, horizontal ? length : rule, horizontal ? rule : length, rule / 2);
    const place = (t: number) => {
      const { pw, ph } = size(t);
      return (horizontal ? (ph - inset) / 2 : (pw - inset) / 2) * towards - (rule / 2) * towards;
    };
    const stretch = (t: number) => (popScale(t) * ((horizontal ? size(t).pw : size(t).ph) - inset - 2 * rule)) / length;
    const shape = ctx.shape(name, panelFrom, path, {
      x: horizontal ? hold(cx) : frames((t) => cx + popScale(t) * place(t), 0.15),
      y: horizontal ? frames((t) => cy + popScale(t) * place(t), 0.15) : hold(cy),
      sx: horizontal ? frames(stretch, 0.003) : frames(popScale, 0.003),
      sy: horizontal ? frames(popScale, 0.003) : frames(stretch, 0.003),
      o: frames(alive, 0.004),
    }, RULE);
    pieces.push({ ...shape, z: 3 });
  };
  ruleSide("rule-top", true, -1);
  ruleSide("rule-bottom", true, 1);
  ruleSide("rule-left", false, -1);
  ruleSide("rule-right", false, 1);

  // The bulb ring. Between two growth steps the sign has one size, and its ring is drawn as a few strips: per side of the sign, the
  // dark brass dots and, for each third of the ring (they share one chase), the cream cores with their halo as a border, so a ring
  // costs a few dozen small bitmaps per frame, never one sign-sized one. When the sign grows to a new size a ring for that size takes over from the old
  // one in a short cross-fade, after the frame has nearly reached it. Corner bulbs, spacing and the count of at most 24 follow the
  // sample's ring (a bulb at every corner, evenly spaced along each side), laid out on the sign's size.
  const m = frameW / 2;
  const ringAt = (pw: number, ph: number) => {
    const inW = pw - 2 * m;
    const inH = ph - 2 * m;
    let pitch = BULB_PITCH * u;
    let nTop = 0;
    let nSide = 0;
    for (let tries = 0; tries < 12; tries++) {
      nTop = Math.max(0, Math.round(inW / pitch) - 1);
      nSide = Math.max(0, Math.round(inH / pitch) - 1);
      if (4 + 2 * nTop + 2 * nSide <= MAX_BULBS) break;
      pitch *= 1.12;
    }
    // Each bulb knows the side of the sign it sits on (a corner belongs to the side it starts): a ring piece is drawn per side, so
    // its bitmap is a thin strip, not the whole sign.
    const pts: { x: number; y: number; side: number }[] = [{ x: -inW / 2, y: -inH / 2, side: 0 }];
    for (let j = 1; j <= nTop; j++) pts.push({ x: -inW / 2 + (inW * j) / (nTop + 1), y: -inH / 2, side: 0 });
    pts.push({ x: inW / 2, y: -inH / 2, side: 1 });
    for (let j = 1; j <= nSide; j++) pts.push({ x: inW / 2, y: -inH / 2 + (inH * j) / (nSide + 1), side: 1 });
    pts.push({ x: inW / 2, y: inH / 2, side: 2 });
    for (let j = nTop; j >= 1; j--) pts.push({ x: -inW / 2 + (inW * j) / (nTop + 1), y: inH / 2, side: 2 });
    pts.push({ x: -inW / 2, y: inH / 2, side: 3 });
    for (let j = nSide; j >= 1; j--) pts.push({ x: -inW / 2, y: -inH / 2 + (inH * j) / (nSide + 1), side: 3 });
    return pts;
  };
  const layouts: { pw: number; ph: number; at: number }[] = [];
  target.forEach((layout, k) => {
    const previous = layouts.at(-1);
    if (previous && Math.abs(previous.pw - layout.pw) < 0.5 && Math.abs(previous.ph - layout.ph) < 0.5) return;
    layouts.push({ pw: layout.pw, ph: layout.ph, at: k === 0 ? panelFrom : Math.max(grow[k]! + 50, (previous?.at ?? panelFrom) + 100) });
  });

  // Chase: every bulb is lit for two steps of three, bright head then a half tail; the key word flashes the whole ring.
  const chaseFrom = panelFrom;
  // The sample flashes from 50 ms before the key word, its words enter 70 ms before.
  const flashAt = hasHero ? enters[heroAt]!.from + 20 : Number.POSITIVE_INFINITY;
  const level = (t: number, third: number) => {
    if (hasHero && t >= flashAt && t < flashAt + FLASH[6]) return (t - flashAt) % 190 < 110 ? 2 : 0;
    const r = (((Math.floor((t - chaseFrom) / STEP_MS) - third) % 3) + 3) % 3;
    return r === 0 ? 2 : r === 1 ? 1 : 0;
  };
  const changes: number[] = [];
  for (let p = 1; chaseFrom + p * STEP_MS < exitBound; p++) changes.push(Math.round(chaseFrom + p * STEP_MS));
  if (hasHero) for (const at of FLASH) if (flashAt + at > chaseFrom && flashAt + at < exitBound) changes.push(Math.round(flashAt + at));
  changes.sort((a, b) => a - b);
  /** A track that is smooth except for the chase's jumps: each stretch between two jumps is sampled on its own. */
  const stepped = (fn: (t: number) => number, a: number, b: number, extra: number[]): Frames => {
    const cuts = [Math.round(a), ...changes.filter((t) => t > a + 1 && t < b - 1), Math.round(b)];
    const out: [number, number][] = [];
    cuts.slice(0, -1).forEach((lo, i) => {
      const hi = cuts[i + 1]!;
      const last = i === cuts.length - 2;
      const end = last ? hi : hi - 1;
      const sub = end > lo ? sampleFrames(fn, extra, 0.004, { range: [lo, end], simplify: true }) : [[lo, fn(lo)] as const];
      for (const frame of sub) out.push([frame[0], frame[1]]);
      // A constant stretch comes back as one frame: hold it to the end, so the next stretch's first frame is a step, not a ramp.
      const tail = out.at(-1)!;
      if (tail[0] < end) out.push([end, tail[1]]);
    });
    return out;
  };
  const key = hash(`${index}:${cue.words.map((word) => word.text).join(" ")}`);
    const discs = (points: readonly { x: number; y: number }[], radius: number): PathCmd[] => points.flatMap(({ x, y }) => ellipsePath(x, y, radius));
  layouts.forEach((layout, at) => {
    const next = layouts[at + 1];
    const from = layout.at;
    const until = next ? Math.min(to, Math.round(next.at + 51)) : to;
    if (until <= from) return;
    const fadeIn = (t: number) => clamp((t - from) / (at === 0 ? 60 : 70));
    const fadeOut = (t: number) => (next ? 1 - clamp((t - (next.at - 30)) / 80) : 1);
    const window = (t: number) => fadeIn(t) * fadeOut(t) * (1 - leave(t));
    const around = [from, from + 70, ...(next ? [next.at - 30, next.at + 50] : []), panelFrom + openFor, ctx.exitAt, ...grow, ...grow.map((g, k) => g + slide[k]!)];
    const ring = ringAt(layout.pw, layout.ph);
    const track = (o: Frames): Track => ({
      x: [[from, cx]], y: [[from, cy]],
      // The ring follows the sign while it grows (its dots stretch a little for a moment), so it stays on the rim and off the words.
      sx: sampleFrames((t) => (popScale(t) * size(t).pw) / layout.pw, around, 0.003, { range: [from, until], simplify: true }),
      sy: sampleFrames((t) => (popScale(t) * size(t).ph) / layout.ph, around, 0.003, { range: [from, until], simplify: true }),
      o,
    });
    const piece = (id: string, path: PathCmd[], fill: string, alpha: number, z: number, o: Frames, halo = false) => {
      const shape = ctx.shape(id, from, path, track(o), fill);
      // A lit bulb's halo is the border of its cream disc (one piece, not two): a soft amber ring about as wide as the bulb.
      pieces.push({ ...shape, z, toMs: until, bleed: true, fill: { colour: fill, alpha }, ...(halo ? { stroke: { widthPx: BULB_R * u * 1.1, colour: GLOW, alpha: 0.34 } } : {}) });
    };
    for (let side = 0; side < 4; side++) {
      const onSide = ring.map((point, i) => ({ ...point, i })).filter((point) => point.side === side);
      if (onSide.length === 0) continue;
      piece(`dark${at}-${side}`, discs(onSide, BULB_R * u), BULB_OFF, 1, 4, sampleFrames(window, around, 0.004, { range: [from, until], simplify: true }));
      for (let third = 0; third < 3; third++) {
        const mine = onSide.filter((point) => point.i % 3 === third);
        if (mine.length === 0) continue;
        piece(`core${at}-${side}${third}`, discs(mine, BULB_R * u), c.accent, 1, 5, stepped((t) => (level(t, third) > 0 ? 1 : 0) * window(t), from, until, around), true);
      }
    }
  });

  // Words (a broken word is one piece per part, `w<word>l<part>`).
  for (const [at, unit] of units.entries()) {
    const word = cue.words[unit.word]!;
    const cell = cellAt.get(at)!;
    const hero = word.role === "hero";
    const { from, settled } = enters[unit.word]!;
    const room = Math.max(1, settled - from);
    const ramp = Math.min(60, room);
    const popFor = hero ? clamp(room / 0.15, 100, 420) : clamp(2 * room, 100, 260);
    // The start size is as large as the plate and the safe area allow.
    const here = target[unit.word]!.pos.get(at)!;
    const halfW = cell.width / 2;
    const halfH = (cell.inkBottom - cell.inkTop) / 2;
    const room1 = Math.min(
      (target[unit.word]!.pw / 2 - (FRAME_W + 0.6 * PAD_X) * u - Math.abs(here.x)) / halfW,
      Math.min(safe.x2 - margin - (cx + here.x), cx + here.x - safe.x1 - margin) / halfW,
      (target[unit.word]!.ph / 2 - (FRAME_W + 0.6 * PAD_Y) * u - Math.abs(here.y)) / Math.max(1, halfH),
    );
    const start = clamp(room1 * 0.995, 1, hero ? 1.3 : 1.12);
    const pop = (t: number) => prog(t, from, popFor);
    // Words open and shut with the sign (position and size), so the plate holds them while it pops.
    const scale = (t: number) => lerp(start, 1, hero ? EASES.spring(pop(t)) : EASES.outExpo(pop(t))) * popScale(t);
    const opacity = (t: number) => lerp(0.1, 1, clamp(prog(t, from, ramp))) * (1 - leave(t));
    const wordEdges = [from, from + ramp, from + popFor, ...grow, ...grow.map((s, k) => s + slide[k]!), ctx.exitAt, to];
    const sample = (fn: (t: number) => number, tolerance: number) => sampleFrames(fn, wordEdges, tolerance, { range: [from, Math.max(to, from + 1)], simplify: true });
    const s = sample(scale, 0.002);
    const piece = ctx.face(cell, from, hero ? c.highlight : c.primary, {
      x: sample((t) => cx + position(at, t).x * popScale(t), 0.15), y: sample((t) => cy + position(at, t).y * popScale(t), 0.15), sx: s, sy: s, o: sample(opacity, 0.004),
    });
    piece.id = `${ctx.id}:w${unit.word}${unit.parts > 1 ? `l${unit.part}` : ""}`;
    piece.origin = { dx: 0, dy: mid.get(at)! };
    // Only the key word glows (a blurred copy of every word is the dearest thing on screen after the sign itself).
    if (hero) piece.shadows = [{ dx: 0, dy: 0, blur: 9 * u, colour: GLOW, alpha: 0.7 }];
    pieces.push(piece);
  }

  // A window too short for the moving beats (a 70 ms cue at a zero gap) gets a compact pose: the same piece, still, painted on every frame.
  const compact = exitBound - panelFrom < 240;

  // Beat 1, every cue: a soft sweep of light crosses the plate under the words as the sign opens, and in gold when the key word lands.
  // Both colours are fixed: the lightest the plate gets under a word stays below the 3:1 bar the brand guard reads against.
  const sweep = (name: string, wanted: number, length: number, colour: string, alpha: number) => {
    const at = compact ? panelFrom : wanted;
    const dur = Math.min(length, exitBound - at);
    if (dur < 33) return;
    const still = compact || dur < 134;
    const half = innerH / 2 + 4 * u;
    const lean = 26 * u;
    const path: PathCmd[] = [["M", -34 * u + lean, -half], ["L", 34 * u + lean, -half], ["L", 34 * u - lean, half], ["L", -34 * u - lean, half], ["Z"]];
    const span = (fn: (t: number) => number, tolerance: number) =>
      sampleFrames(fn, [at, at + dur, ...grow, ...grow.map((s, k) => s + slide[k]!)], tolerance, { range: [at, at + dur], simplify: true });
    const across = (t: number) => (still ? 0.15 : lerp(-1, 1, EASES.out(prog(t, at, dur))));
    const shape = ctx.shape(name, at, path, {
      x: span((t) => cx + across(t) * (size(t).pw / 2 + (still ? 0 : 40 * u)), 0.2), y: hold(cy),
    }, colour);
    pieces.push({
      ...shape, z: 3, fromMs: at, toMs: Math.min(to, at + dur + 1), fill: { colour, alpha },
      track: { ...shape.track, o: [[at, 1]] },
      clip: {
        x1: span((t) => cx - (size(t).pw - inset) / 2, 0.2), x2: span((t) => cx + (size(t).pw - inset) / 2, 0.2),
        y1: span((t) => cy - (size(t).ph - inset) / 2, 0.2), y2: span((t) => cy + (size(t).ph - inset) / 2, 0.2),
      },
    });
  };
  sweep("sweep0", first.from + 40, 440, "#FFFFFF", 0.14);
  if (hasHero) sweep("sweep1", enters[heroAt]!.from + 20, 400, "#FFD060", 0.16);

  // Beat 2, every cue: a pair of glints on diagonal corners of the frame when the last word has arrived.
  // Fast speech: they land by the cue's end at the latest, and in a window under 134 ms they are drawn still.
  const wanted = steps[steps.length - 1]! + 60;
  const glintAt = Math.max(panelFrom, Math.min(wanted, exitBound - Math.min(134, exitBound - panelFrom)));
  const glintLife = Math.min(420, exitBound - glintAt);
  if (glintLife >= 33) {
    const corner = key % 4;
    [corner, (corner + 2) % 4].forEach((which, n) => {
      const sx = which === 0 || which === 3 ? -1 : 1;
      const sy = which < 2 ? -1 : 1;
      const radius = (n === 0 ? 26 : 18) * u;
      const at = glintAt + n * 90;
      const life = Math.min(glintLife, exitBound - at);
      if (life < 33) return;
      const gx = clamp(cx + sx * (pwF / 2 + 8 * u), safe.x1 + radius * 1.5 + margin, safe.x2 - radius * 1.5 - margin);
      const gy = clamp(cy + sy * (phF / 2 + 8 * u), safe.y1 + radius * 1.5 + margin, safe.y2 - radius * 1.5 - margin);
      const still = life < 134;
      const grows: Frames = still ? [[at, 1]] : [[at, 0], [at + life * 0.3, 1, "outBack"], [at + life, 0, "in"]];
      const shape = ctx.shape(`glint${n}`, at, sparklePath(radius), {
        x: hold(gx), y: [[at, gy]], sx: grows, sy: grows,
        rz: still ? [[at, 0]] : [[at, -30 * sx], [at + life, 60 * sx]], o: [[at, 1]],
      }, c.accent);
      pieces.push({ ...shape, z: 8, toMs: Math.min(to, at + life + 1) });
    });
  }

  // Beat 3, key-word cues: short gold rays burst from the frame while the bulbs flash (only where the sign has reached its size and the safe area has room).
  if (hasHero && Number.isFinite(flashAt)) {
    const now = size(flashAt + 80);
    const count = 12;
    const offset = rand(key, 1) * ((Math.PI * 2) / count);
    for (let j = 0; j < count; j++) {
      const angle = offset + j * ((Math.PI * 2) / count) + (rand(key, 10 + j) - 0.5) * 0.25;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const dist = (w: number, h: number) => Math.min(Math.abs(dx) < 1e-6 ? Number.POSITIVE_INFINITY : w / 2 / Math.abs(dx), Math.abs(dy) < 1e-6 ? Number.POSITIVE_INFINITY : h / 2 / Math.abs(dy));
      const final = dist(pwF * 1.0, phF * 1.0);
      if (final - dist(now.pw, now.ph) > 70 * u) continue;
      const r0 = final + 18 * u;
      const reach = Math.min(
        dx > 0 ? (safe.x2 - 6 * u - cx) / dx : dx < 0 ? (safe.x1 + 6 * u - cx) / dx : Number.POSITIVE_INFINITY,
        dy > 0 ? (safe.y2 - 6 * u - cy) / dy : dy < 0 ? (safe.y1 + 6 * u - cy) / dy : Number.POSITIVE_INFINITY,
      );
      const free = reach - r0;
      if (free < 34 * u) continue;
      const length = Math.min((34 + rand(key, 30 + j) * 26) * u, free * 0.6);
      const travel = Math.min(26 * u, free - length);
      const at = flashAt;
      const dur = Math.min(320, exitBound - at);
      if (dur < 67) break;
      const thick = 5 * u;
      const path: PathCmd[] = [["M", 0, 0], ["L", length, 0], ["L", length, thick], ["L", 0, thick], ["Z"]];
      const span = (g: (p: number) => number, tolerance: number) =>
        sampleFrames((t) => g(prog(t, at, dur)), [at, at + dur * 0.3, at + dur], tolerance, { range: [at, at + dur], simplify: true });
      const shape = ctx.shape(`ray${j}`, at, path, {
        x: span((p) => cx + dx * (r0 + travel * EASES.out(p)), 0.2), y: span((p) => cy + dy * (r0 + travel * EASES.out(p)), 0.2),
        sx: span((p) => 0.3 + 0.7 * EASES.out(clamp(p * 2)), 0.004), sy: [[at, 1]], rz: [[at, (angle * 180) / Math.PI]],
        o: span((p) => EASES.out(clamp(p / 0.2)) * (1 - EASES.in(clamp((p - 0.4) / 0.6))), 0.004),
      }, c.highlight);
      pieces.push({ ...shape, z: 7, toMs: Math.min(to, at + dur + 1), origin: { dx: 0, dy: thick / 2 }, fill: { colour: c.highlight, alpha: 0.9 } });
    }
  }
  return pieces;
});
