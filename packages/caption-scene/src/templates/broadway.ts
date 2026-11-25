import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import { captionTextClusters } from "@narriflow/caption-fonts/caption-block";
import { SAFE_INSET, balancedRows } from "../layout";
import type { ColourFrames, PathCmd, Piece, TextPiece } from "../scene";
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
 * - **Bulbs are individual, stable pieces.** The sample re-spaces the ring from the live panel size every frame, so bulbs hop
 *   along it when the count changes. Here each bulb keeps its place on the ring and appears (scale and fade) as the growing
 *   frame reaches it; the corner bulbs ride the frame. The ring is at most 28 bulbs; the chase runs over the final ring's order.
 *   A bulb is a dim brass dot that lights cream with a soft halo disc (no blur), 1 of every 3 is dark, as in the sample.
 * - **Hero pop stays on the plate.** The sample's 1.3x start would run past the frame for a wide key word; it starts as large
 *   as the plate and the safe area allow (at most 1.3x). The panel's own spring overshoot is trimmed to about 4%.
 * - **The exit waits for the speech.** It starts once the last word has been readable for 150 ms and is the sample's 190 ms
 *   shut-off, shortened when the next cue is sooner (a hard cut when there is no room). The sample's frozen dim bulbs are gone:
 *   bulbs fade out with the sign.
 * - **Cheap shadows.** The frame's two box-shadows are dropped (the near-black frame stands out on its own and a blurred copy of the
 *   whole sign costs every frame); the words' glow is one blurred shadow.
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
const MAX_BULBS = 28;
const STEP_MS = 90;
const SLIDE = 320;
const WORD_LEAD = 70;
const SIMPLE = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{P}\p{S}]+$/u;
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

interface Bulb {
  readonly kind: "corner" | "top" | "bottom" | "left" | "right";
  /** Corner: sign of x and y. Top and bottom: x from the centre. Sides: distance down from the inner top edge. */
  readonly a: number;
  readonly b: number;
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
      const per = Math.ceil(clusters.length / parts);
      return Array.from({ length: Math.ceil(clusters.length / per) }, (_, part) => {
        const text = parts === 1 ? word.text : clusters.slice(part * per, (part + 1) * per).join("");
        const w100 = parts === 1 ? width100[wi]! : measure(text, FACE, 100, SPACING).advance;
        return { word: wi, part, parts: Math.ceil(clusters.length / per), text, w100, size: Math.min(natural, (rowMax / Math.max(1, w100)) * 100) };
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
  const startPos: Map<number, { x: number; y: number }>[] = [];
  const startSize: { pw: number; ph: number }[] = [];
  cue.words.forEach((_, k) => {
    const out = new Map<number, { x: number; y: number }>();
    const old: number[] = [];
    if (k === 0) startSize.push({ pw: target[0]!.pw, ph: target[0]!.ph });
    else {
      const e = EASES.outExpo(prog(steps[k]!, steps[k - 1]!, SLIDE));
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
    for (let s = 0; s < steps.length; s++) if (t >= steps[s]!) k = s;
    return k;
  };
  const position = (i: number, t: number) => {
    const k = Math.max(units[i]!.word, stepAt(t));
    const e = EASES.outExpo(prog(t, steps[k]!, SLIDE));
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
    const e = EASES.outExpo(prog(t, steps[k]!, SLIDE));
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
  const alive = (t: number) => lerp(aliveFrom, 1, clamp(open(t) * 4)) * (1 - leave(t));
  const edges = [panelFrom, panelFrom + openFor, ...steps, ...steps.map((s) => s + SLIDE), ctx.exitAt, to];
  const frames = (fn: (t: number) => number, tolerance: number, a = panelFrom, b = to, extra: number[] = []) =>
    sampleFrames(fn, [...edges, ...extra], tolerance, { range: [a, Math.max(b, a + 1)], simplify: true });
  const exitBound = ctx.exit ? ctx.exitAt : to;

  const pieces: Piece[] = [];
  const inset = 2 * frameW;
  const innerW = pwF - inset;
  const innerH = phF - inset;
  const hold = (value: number): Frames => [[panelFrom, value]];

  // The sign: frame and plate grow with the words.
  const frame = ctx.shape("sign", panelFrom, roundedRectPath(-pwF / 2, -phF / 2, pwF, phF, 40 * u), {
    x: hold(cx), y: hold(cy),
    sx: frames((t) => (popScale(t) * size(t).pw) / pwF, 0.003), sy: frames((t) => (popScale(t) * size(t).ph) / phF, 0.003),
    o: frames(alive, 0.004),
  }, FRAME);
  pieces.push({ ...frame, z: 1 });
  const plate = ctx.shape("plate", panelFrom, roundedRectPath(-innerW / 2, -innerH / 2, innerW, innerH, 14 * u), {
    x: hold(cx), y: hold(cy),
    sx: frames((t) => (popScale(t) * (size(t).pw - inset)) / innerW, 0.003), sy: frames((t) => (popScale(t) * (size(t).ph - inset)) / innerH, 0.003),
    o: frames(alive, 0.004),
  }, PLATE);
  pieces.push({ ...plate, z: 2, stroke: { widthPx: 3 * u, colour: RULE } });

  // The bulb ring, laid out for the final sign: corner bulbs ride the frame, the others keep their place and appear as it reaches them.
  const m = frameW / 2;
  const inW = pwF - 2 * m;
  const inH = phF - 2 * m;
  let pitch = BULB_PITCH * u;
  let nTop = 0;
  let nSide = 0;
  for (let tries = 0; tries < 12; tries++) {
    nTop = Math.max(0, Math.round(inW / pitch) - 1);
    nSide = Math.max(0, Math.round(inH / pitch) - 1);
    if (4 + 2 * nTop + 2 * nSide <= MAX_BULBS) break;
    pitch *= 1.12;
  }
  const spanTop = inW / (nTop + 1);
  const spanSide = inH / (nSide + 1);
  const ring: Bulb[] = [{ kind: "corner", a: -1, b: -1 }];
  for (let j = 1; j <= nTop; j++) ring.push({ kind: "top", a: -inW / 2 + spanTop * j, b: 0 });
  ring.push({ kind: "corner", a: 1, b: -1 });
  for (let j = 1; j <= nSide; j++) ring.push({ kind: "right", a: spanSide * j, b: 0 });
  ring.push({ kind: "corner", a: 1, b: 1 });
  for (let j = nTop; j >= 1; j--) ring.push({ kind: "bottom", a: -inW / 2 + spanTop * j, b: 0 });
  ring.push({ kind: "corner", a: -1, b: 1 });
  for (let j = nSide; j >= 1; j--) ring.push({ kind: "left", a: spanSide * j, b: 0 });
  const bulbAt = (bulb: Bulb, t: number) => {
    const { pw, ph } = size(t);
    const hw = pw / 2 - m;
    const hh = ph / 2 - m;
    let x = 0;
    let y = 0;
    let room = 1;
    switch (bulb.kind) {
      case "corner": x = bulb.a * hw; y = bulb.b * hh; break;
      case "top": x = bulb.a; y = -hh; room = (hw - Math.abs(bulb.a)) / spanTop; break;
      case "bottom": x = bulb.a; y = hh; room = (hw - Math.abs(bulb.a)) / spanTop; break;
      case "right": x = hw; y = -hh + bulb.a; room = (2 * hh - bulb.a) / spanSide; break;
      case "left": x = -hw; y = -hh + bulb.a; room = (2 * hh - bulb.a) / spanSide; break;
    }
    const shown = clamp((room - 0.45) / 0.3);
    const pop = popScale(t);
    return { x: cx + x * pop, y: cy + y * pop, s: Math.max(0.02, shown * pop) };
  };

  // Chase: every bulb is lit for two steps of three, bright head then a half tail; the key word flashes the whole ring.
  const chaseFrom = panelFrom;
  // The sample flashes from 50 ms before the key word, its words enter 70 ms before.
  const flashAt = hasHero ? enters[heroAt]!.from + 20 : Number.POSITIVE_INFINITY;
  const level = (t: number, i: number) => {
    if (hasHero && t >= flashAt && t < flashAt + FLASH[6]) return (t - flashAt) % 190 < 110 ? 2 : 0;
    const r = (((Math.floor((t - chaseFrom) / STEP_MS) - i) % 3) + 3) % 3;
    return r === 0 ? 2 : r === 1 ? 1 : 0;
  };
  const changes: number[] = [];
  for (let p = 1; chaseFrom + p * STEP_MS < exitBound; p++) changes.push(chaseFrom + p * STEP_MS);
  if (hasHero) for (const at of FLASH) if (flashAt + at > chaseFrom && flashAt + at < exitBound) changes.push(flashAt + at);
  changes.sort((a, b) => a - b);
  const haloAlpha = [0, 0.7, 1] as const;
  const key = hash(`${index}:${cue.words.map((word) => word.text).join(" ")}`);
  // Every bulb is sampled on one shared grid of times (dense where the sign opens, grows or shuts, so it follows the same curves),
  // so a ring of bulbs adds a handful of distinct keyframe times to the cue, not a handful per bulb.
  const GROW = [0.03, 0.06, 0.1, 0.15, 0.2, 0.27, 0.35, 0.45, 0.6, 0.8, 1] as const;
  const gridTimes = new Set<number>([panelFrom, to]);
  for (let n = 0; n <= 12; n++) gridTimes.add(panelFrom + (openFor * n) / 12);
  for (const at of steps) for (const p of GROW) gridTimes.add(at + SLIDE * p);
  if (ctx.exit) for (let n = 0; n <= 6; n++) gridTimes.add(ctx.exitAt + (exitFor * n) / 6);
  const gridAt = [...gridTimes].map((t) => Math.round(t * 10) / 10).filter((t) => t >= panelFrom && t <= to).sort((a, b) => a - b).filter((t, i, all) => i === 0 || t > all[i - 1]!);
  const grid = (fn: (t: number) => number): Frames => {
    const values = gridAt.map((t) => fn(t));
    const kept: [number, number][] = [];
    values.forEach((value, i) => {
      const same = (j: number) => values[j] !== undefined && Math.abs(values[j]! - value) < 1e-3;
      if (i > 0 && i < values.length - 1 && same(i - 1) && same(i + 1)) return;
      kept.push([gridAt[i]!, value]);
    });
    return kept;
  };
  const fader: Frames = ctx.exit ? [[panelFrom, 1], [ctx.exitAt, 1], [to, 0, "in"]] : [[panelFrom, 1]];
  ring.forEach((bulb, i) => {
    const x = grid((t) => bulbAt(bulb, t).x);
    const y = grid((t) => bulbAt(bulb, t).y);
    const s = grid((t) => bulbAt(bulb, t).s);
    let lastAt = chaseFrom;
    let value = level(chaseFrom, i);
    const colour: [number, string][] = [[chaseFrom, value > 0 ? c.accent : BULB_OFF]];
    const halo: [number, number][] = [[chaseFrom, haloAlpha[value]!]];
    for (const at of changes) {
      const next = level(at + 0.001, i);
      const whole = Math.round(at);
      if (next === value || whole <= lastAt + 1) continue;
      colour.push([whole, value > 0 ? c.accent : BULB_OFF], [whole + 1, next > 0 ? c.accent : BULB_OFF]);
      halo.push([whole, haloAlpha[value]!], [whole + 1, haloAlpha[next]!]);
      value = next;
      lastAt = whole + 1;
    }
    const core = ctx.shape(`bulb${i}`, panelFrom, ellipsePath(0, 0, BULB_R * u), { x, y, sx: s, sy: s, o: ctx.exit ? fader : hold(1), colour: colour as ColourFrames }, BULB_OFF);
    // Bulbs always sit inside the frame, which is what bounds the sign: leave them out of the per-frame bounds scans (cost).
    pieces.push({ ...core, z: 4, bleed: true });
    const haloFrames: Frames = ctx.exit ? [...halo, [Math.max(ctx.exitAt, lastAt + 1), haloAlpha[value]!], [to, 0, "in"]] : halo;
    const glow = ctx.shape(`glow${i}`, panelFrom, ellipsePath(0, 0, BULB_R * u * 2.3), { x, y, sx: s, sy: s, o: haloFrames }, GLOW);
    pieces.push({ ...glow, z: 3, bleed: true, fill: { colour: GLOW, alpha: 0.32 } });
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
      (target[unit.word]!.pw / 2 - 1.2 * frameW - Math.abs(here.x)) / halfW,
      Math.min(safe.x2 - margin - (cx + here.x), cx + here.x - safe.x1 - margin) / halfW,
      (target[unit.word]!.ph / 2 - 1.2 * frameW - Math.abs(here.y)) / Math.max(1, halfH),
    );
    const start = clamp(room1 * 0.995, 1, hero ? 1.3 : 1.12);
    const pop = (t: number) => prog(t, from, popFor);
    const scale = (t: number) => lerp(start, 1, hero ? EASES.spring(pop(t)) : EASES.outExpo(pop(t))) * (1 - 0.1 * leave(t));
    const opacity = (t: number) => lerp(0.1, 1, clamp(prog(t, from, ramp))) * (1 - leave(t));
    const wordEdges = [from, from + ramp, from + popFor, ...steps, ...steps.map((s) => s + SLIDE), ctx.exitAt, to];
    const sample = (fn: (t: number) => number, tolerance: number) => sampleFrames(fn, wordEdges, tolerance, { range: [from, Math.max(to, from + 1)], simplify: true });
    const s = sample(scale, 0.002);
    const piece = ctx.face(cell, from, hero ? c.highlight : c.primary, {
      x: sample((t) => cx + position(at, t).x, 0.15), y: sample((t) => cy + position(at, t).y, 0.15), sx: s, sy: s, o: sample(opacity, 0.004),
    });
    piece.id = `${ctx.id}:w${unit.word}${unit.parts > 1 ? `l${unit.part}` : ""}`;
    piece.origin = { dx: 0, dy: mid.get(at)! };
    piece.shadows = [{ dx: 0, dy: 0, blur: 9 * u, colour: GLOW, alpha: hero ? 0.7 : 0.45 }];
    pieces.push(piece);
  }

  // Beat 1, every cue: a soft sweep of light crosses the plate under the words as the sign opens, and in gold when the key word lands.
  const sweep = (name: string, at: number, length: number, colour: string, alpha: number) => {
    const dur = Math.min(length, exitBound - at);
    if (dur < 67) return;
    const half = innerH / 2 + 4 * u;
    const lean = 26 * u;
    const path: PathCmd[] = [["M", -34 * u + lean, -half], ["L", 34 * u + lean, -half], ["L", 34 * u - lean, half], ["L", -34 * u - lean, half], ["Z"]];
    const span = (fn: (t: number) => number, tolerance: number) =>
      sampleFrames(fn, [at, at + dur, ...steps, ...steps.map((s) => s + SLIDE)], tolerance, { range: [at, at + dur], simplify: true });
    const shape = ctx.shape(name, at, path, {
      x: span((t) => cx + lerp(-1, 1, EASES.out(prog(t, at, dur))) * (size(t).pw / 2 + 40 * u), 0.2), y: hold(cy),
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
  sweep("sweep0", first.from + 40, 440, "#FFFFFF", 0.16);
  if (hasHero) sweep("sweep1", enters[heroAt]!.from + 20, 400, c.highlight, 0.22);

  // Beat 2, every cue: a pair of glints on diagonal corners of the frame when the last word has arrived.
  // Fast speech: the glints land by the cue's end at the latest, as a compact pose.
  const glintAt = Math.min(steps[steps.length - 1]! + 60, Math.max(panelFrom + 33, exitBound - 134));
  const glintLife = Math.min(420, exitBound - glintAt);
  if (glintLife >= 67) {
    const corner = key % 4;
    [corner, (corner + 2) % 4].forEach((which, n) => {
      const sx = which === 0 || which === 3 ? -1 : 1;
      const sy = which < 2 ? -1 : 1;
      const radius = (n === 0 ? 26 : 18) * u;
      const at = glintAt + n * 90;
      const life = Math.min(glintLife, exitBound - at);
      if (life < 67) return;
      const gx = clamp(cx + sx * (pwF / 2 + 8 * u), safe.x1 + radius * 1.5 + margin, safe.x2 - radius * 1.5 - margin);
      const gy = clamp(cy + sy * (phF / 2 + 8 * u), safe.y1 + radius * 1.5 + margin, safe.y2 - radius * 1.5 - margin);
      const shape = ctx.shape(`glint${n}`, at, sparklePath(radius), {
        x: hold(gx), y: [[at, gy]],
        sx: [[at, 0], [at + life * 0.3, 1, "outBack"], [at + life, 0, "in"]], sy: [[at, 0], [at + life * 0.3, 1, "outBack"], [at + life, 0, "in"]],
        rz: [[at, -30 * sx], [at + life, 60 * sx]], o: [[at, 1]],
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
