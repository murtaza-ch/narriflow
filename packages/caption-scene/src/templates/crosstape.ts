import type { DemoScript } from "../demo";
import type { SceneWord } from "../input";
import type { Piece } from "../scene";
import type { SpeechCell } from "./speech-layout";
import { caps, galleryScene, inkCentre, roleRows, rotatePoint, rowBounds, rowsOf } from "./gallery-layout";

export const CROSSTAPE_DEMO: DemoScript = {
  lines: ["nobody is:m coming to:m save you:h@520", "less talking more doing", "post before:m you:m feel ready:h@560", "keep going", "small steps win:h@520"],
  options: { rate: 225, gap: 30, cueGap: 170, tail: 650, lead: 350 },
};

const HERO_FACE = "Inter Tight ExtraBold";
const HERO_MAX = 104;
/** Widest hero ink the crossing slot holds (the sample's black strip, 270 px less its padding), and the smallest hero size worth crossing for (about the 62 px body; below it the hero gets its own row). */
const CROSS_SLOT = 222;
const CROSS_HERO_MIN = 64;
/** Widest hero ink on its own row. */
const STACK_SLOT = 600;
/** Space kept between a row's ink and any other row's tape. */
const CLEARANCE = 4;

interface Plate {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly tilt: number;
}

/** Whether two turned rectangles come closer than `gap` (separating-axis test). */
function platesMeet(a: Plate, b: Plate, gap: number): boolean {
  const axes = (plate: Plate) => {
    const r = plate.tilt * Math.PI / 180;
    return [[Math.cos(r), Math.sin(r)], [-Math.sin(r), Math.cos(r)]] as const;
  };
  const reach = (plate: Plate, [nx, ny]: readonly [number, number]) => {
    const [u, v] = axes(plate);
    return plate.w / 2 * Math.abs(nx * u[0] + ny * u[1]) + plate.h / 2 * Math.abs(nx * v[0] + ny * v[1]);
  };
  for (const axis of [...axes(a), ...axes(b)]) {
    const n = axis as readonly [number, number];
    if (Math.abs((b.x - a.x) * n[0] + (b.y - a.y) * n[1]) >= reach(a, n) + reach(b, n) + gap) return false;
  }
  return true;
}

interface Placed {
  readonly row: SpeechCell[];
  readonly hero: boolean;
  /** Index among the plain rows, which alternate saffron and grey. */
  readonly k: number;
  readonly tilt: number;
  readonly w: number;
  readonly h: number;
  readonly extra: number;
  /** Where the row's text is centred, and the tape's centre. */
  readonly cx: number;
  readonly cy: number;
  readonly ink: Plate;
  readonly tape: Plate;
}

export const crosstapeProgram = galleryScene("crosstape", 1296, (ctx) => {
  const { cue, to } = ctx.window;
  const c = ctx.input.colours;
  const heroes = cue.words.filter((word) => word.role === "hero").length;
  const heroLast = heroes === 0 || (heroes === 1 && cue.words.at(-1)!.role === "hero");
  const heroAdvance = (word: SceneWord) => ctx.input.measure(caps(word, cue), HERO_FACE, 100, -0.012).advance;
  const words = (slot: number) => cue.words.map((word) => {
    const hero = word.role === "hero";
    return { text: hero ? caps(word, cue) : word.text, size: hero ? Math.min(HERO_MAX, slot * 100 / Math.max(1, heroAdvance(word))) : 62,
      face: hero ? HERO_FACE : "Inter Tight SemiBold", spacing: -0.012 } as const;
  });

  /** The sample's X: two plain tapes cross, the hero lies on the end of the second. */
  const cross = () => {
    const groups = roleRows(cue, 9).flatMap((row) => {
      if (row.length <= 1 || (heroes === 0 && row.length <= 2)) return [row];
      const first = row.length === 2 ? 1 : 2;
      return [row.slice(0, first), row.slice(first)];
    });
    return { groups, slot: CROSS_SLOT, crossing: true };
  };
  /** Rows in reading order, pushed apart until no tape lies over another row's words. */
  const stack = () => ({ groups: roleRows(cue, 9), slot: STACK_SLOT, crossing: false });

  const arrange = (mode: { groups: number[][]; slot: number; crossing: boolean }) => {
    const { cells, unit: u } = ctx.layout({ column: 670, gap: 17, padding: 118, groups: mode.groups, words: [...words(mode.slot)] });
    const rows = rowsOf(cells);
    const isHero = (row: SpeechCell[]) => cue.words[row[0]!.at]!.role === "hero";
    const plainCount = rows.filter((row) => !isHero(row)).length;
    const crossX = ctx.space.x(540) + 190 * u * ctx.side;
    const crossY = ctx.space.y(1296);
    let plain = 0;
    const placed: Placed[] = rows.map((row) => {
      const hero = isHero(row);
      const k = hero ? -1 : plain++;
      const b = rowBounds(row);
      const tilt = (mode.crossing ? (hero || k % 2 ? -13 : 11) : hero ? -13 : plainCount <= 1 ? -5 : k % 2 ? -6 : 8) * ctx.side;
      const crossRow = mode.crossing && !hero;
      const extra = crossRow ? (k === 0 ? 230 : 190) * u : 0;
      const inkW = b.x2 - b.x1;
      const h = (hero ? 118 : 96) * u;
      const w = inkW + 56 * u + extra;
      const lineX = (b.x1 + b.x2) / 2;
      const lineY = (b.y1 + b.y2) / 2;
      const [dx, dy] = rotatePoint(-(inkW / 2 + extra - 32 * u) * ctx.side, 0, tilt);
      const [tagX, tagY] = rotatePoint((w / 2 - 10 * u) * ctx.side, 0, tilt);
      const cx = crossRow ? crossX + dx : mode.crossing ? crossX + tagX : lineX;
      const cy = crossRow ? crossY + dy : mode.crossing ? crossY + tagY : lineY;
      const px = cx + Math.cos(tilt * Math.PI / 180) * extra * ctx.side / 2;
      const py = cy + Math.sin(tilt * Math.PI / 180) * extra * ctx.side / 2;
      return { row, hero, k, tilt, w, h, extra, cx, cy,
        ink: { x: cx, y: cy, w: inkW, h: b.y2 - b.y1, tilt }, tape: { x: px, y: py, w, h, tilt } };
    });
    const gap = CLEARANCE * u;
    // Text is drawn over every tape, and an earlier tape lies under its own row's tape, so a word is only hidden or
    // camouflaged by a LATER row's tape (saffron text on the next row's saffron tape).
    const clash = (earlier: Placed, later: Placed) => platesMeet(earlier.ink, later.tape, gap);
    if (mode.crossing) {
      const clear = placed.every((a, i) => placed.slice(i + 1).every((b) => !clash(a, b)));
      return { placed, clear, u };
    }
    // Stack: each row sits as close under the one before as its tilted tape allows without lying over any earlier row's words.
    const mid = placed.reduce((sum, p) => sum + p.cy, 0) / placed.length;
    const stacked: Placed[] = [];
    for (const p of placed) {
      let next = p;
      const move = (to: number): Placed => ({ ...p, cy: to, ink: { ...p.ink, y: to }, tape: { ...p.tape, y: p.tape.y + to - p.cy } });
      if (stacked.length) {
        const top = stacked.at(-1)!;
        for (let to = top.cy + (top.h + p.h) / 4; ; to += 3 * u) {
          next = move(to);
          if (stacked.every((a) => !clash(a, next))) break;
        }
      } else next = move(0);
      stacked.push(next);
    }
    const shift = mid - stacked.reduce((sum, p) => sum + p.cy, 0) / stacked.length;
    return { placed: stacked.map((p) => ({ ...p, cy: p.cy + shift, ink: { ...p.ink, y: p.ink.y + shift }, tape: { ...p.tape, y: p.tape.y + shift } })), clear: true, u };
  };

  let layout: ReturnType<typeof arrange> | undefined;
  if (heroLast) {
    const crossing = arrange(cross());
    const slotted = words(CROSS_SLOT);
    const heroFits = cue.words.every((word, at) => word.role !== "hero" || slotted[at]!.size >= CROSS_HERO_MIN);
    const twoPlain = crossing.placed.filter((p) => !p.hero).length === 2;
    if (twoPlain && heroFits && crossing.clear) layout = crossing;
  }
  layout ??= arrange(stack());
  const { placed, u } = layout;

  const pieces: Piece[] = [];
  for (const [i, p] of placed.entries()) {
    const { row, hero, tilt, w, h, cx, cy } = p;
    const b = rowBounds(row);
    const lineX = (b.x1 + b.x2) / 2;
    const lineY = (b.y1 + b.y2) / 2;
    const word = cue.words[Math.min(...row.map((cell) => cell.at))]!;
    const entry = ctx.enter(word, 236);
    const end = Math.max(entry.settled, ...row.map((cell) => cue.words[cell.at]!.startMs));
    const [ex, ey] = rotatePoint(-w / 2 * ctx.side, 0, tilt);
    const fill = hero ? "#0E0E10" : p.k % 2 === 0 ? c.highlight : c.accent;
    const tape = ctx.rect(`tape${i}`, entry.from, p.tape.x + ex, p.tape.y + ey, w, h, 0, fill, {
      rz: [[entry.from, tilt]], sx: [[entry.from, entry.motion ? 0.27 : 1], [end, 1, "outExpo"],
        ...(ctx.exit ? [[ctx.exitAt, 1], [to, 0.06, "in"]] as const : [])],
    });
    tape.origin = { dx: -w / 2 * ctx.side, dy: 0 };
    tape.z = 2 + i;
    tape.shadows = [{ dx: 0, dy: 7 * u, blur: 6 * u, alpha: 0.3, colour: c.shadow }];
    pieces.push(tape);
    for (const cell of row) {
      const { from, motion, settled } = ctx.enter(cue.words[cell.at]!, 206);
      const [rx, ry] = rotatePoint(cell.x - lineX, inkCentre(cell) - lineY, tilt);
      const face = ctx.face(cell, from, hero ? c.highlight : c.primary, {
        x: ctx.drift(from, cx + rx, motion ? -20 * u * ctx.side : 0, settled),
        y: [[from, cy + ry]], rz: [[from, tilt]],
      });
      face.z = 32 + i;
      face.origin = { dx: 0, dy: inkCentre(cell) - cell.baseline };
      pieces.push(face);
    }
  }
  return pieces;
});
