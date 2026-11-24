import type { DemoScript } from "../demo";
import type { Piece } from "../scene";
import { sparklePath } from "../shapes";
import { caps, galleryScene, inkCentre, roleRows, rotatePoint, rowBounds, rowsOf } from "./gallery-layout";

export const SWIPE_DEMO: DemoScript = {
  lines: ["nobody:b wants:b your:m perfect:b plan:h@520", "start:b messy:h@500", "post:b before:b you:m feel:b ready:h@520", "done:b beats:b perfect:b", "trust:b the:m process:h@560"],
  options: { rate: 230, gap: 22, cueGap: 150, tail: 700, lead: 350 },
};

export const swipeProgram = galleryScene("swipe", 1300, (ctx) => {
  const { cue, to } = ctx.window;
  const c = ctx.input.colours;
  const hasHero = cue.words.some((word) => word.role === "hero");
  const groups = roleRows(cue, hasHero ? 9 : 3);
  const words = cue.words.map((word) => ({ text: caps(word, cue), size: word.role === "hero" ? 150 : hasHero ? 88 : 112,
    face: word.role === "hero" ? "Barlow Condensed Bold" : "Barlow Condensed Medium", spacing: 0.03 } as const));
  for (const row of groups) {
    const width = row.reduce((sum, at) => {
      const { face, text, size, spacing } = words[at]!;
      return sum + ctx.input.measure(text, face, size, spacing).advance;
    }, 28 * (row.length - 1));
    const fit = Math.min(1, 700 / Math.max(1, width));
    for (const at of row) words[at] = { ...words[at]!, size: words[at]!.size * fit } as typeof words[number];
  }
  const { cells, unit: u } = ctx.layout({
    column: 736, padding: 75, gap: 28, groups, words,
  });
  const strips = rowsOf(cells).map((row, i) => {
    const hero = row.some((cell) => cue.words[cell.at]!.role === "hero");
    const line = rowBounds(row);
    const tilt = (hero ? 3.5 : i % 2 ? 3.5 : -6.5) * ctx.side;
    const cx = (line.x1 + line.x2) / 2 + (hero ? 26 : i % 2 ? 22 : -34) * u * ctx.side;
    const h = Math.max(Math.max(...row.map((cell) => cell.size)) * (hero ? 1.46 : 1.62), line.y2 - line.y1 + 24 * u);
    const w = line.x2 - line.x1 + h * (hero ? 0.88 : 1.04);
    const [ex, ey] = rotatePoint(-w * ctx.side / 2, 0, tilt);
    const halfHeight = Math.abs(ey) + rotatePoint(0, h / 2, tilt)[1];
    const [cos, sin] = rotatePoint(1, 0, Math.abs(tilt));
    const inkHalfWidth = (line.x2 - line.x1) / 2;
    const inkHalfHeight = (line.y2 - line.y1) / 2;
    const inkX = inkHalfWidth * cos + inkHalfHeight * sin;
    const inkY = inkHalfWidth * sin + inkHalfHeight * cos;
    const [sparkX, sparkY] = rotatePoint((w / 2 - 0.08 * h) * ctx.side, -0.54 * h, tilt);
    const sparkRadius = 0.52 * h * 50 / 120;
    const sparkStroke = 0.52 * h * 9 / 120;
    return { row, hero, line, tilt, cx, w, h, ex, ey, halfHeight, inkX, inkY, sparkX, sparkY, sparkRadius, sparkStroke };
  });
  const positions: number[] = [];
  const clearance = 3 * u;
  for (const [i, strip] of strips.entries()) {
    const previous = strips[i - 1];
    if (!previous) {
      positions.push(strip.h / 2);
      continue;
    }
    // Start with the sample's unrotated pitch. The pads can cross as long as the ink stays clear.
    const sparkReach = strip.sparkRadius + strip.sparkStroke;
    const sparkCentre = strip.cx + strip.sparkX;
    const inkLeft = previous.cx - previous.inkX - (ctx.rtl ? 0 : 18 * u);
    const inkRight = previous.cx + previous.inkX + (ctx.rtl ? 18 * u : 0);
    const sparkCrossesInk = strip.hero && sparkCentre + sparkReach > inkLeft && sparkCentre - sparkReach < inkRight;
    const pitch = Math.max((previous.h + strip.h) / 2 + 24 * u,
      previous.inkY + strip.halfHeight + clearance,
      previous.halfHeight + strip.inkY + clearance,
      sparkCrossesInk ? previous.inkY - strip.sparkY + sparkReach + clearance : 0);
    positions.push(positions[i - 1]! + pitch);
  }
  const height = positions.at(-1)! + strips.at(-1)!.h / 2;
  const top = ctx.space.y(1300) - height / 2;
  const pieces: Piece[] = [];
  for (const [i, { row, hero, line, tilt, cx, w, h, ex, ey, sparkX, sparkY, sparkRadius, sparkStroke }] of strips.entries()) {
    const cy = top + positions[i]!;
    const first = cue.words[Math.min(...row.map((cell) => cell.at))]!;
    const last = cue.words[Math.max(...row.map((cell) => cell.at))]!;
    const { from, motion, settled } = ctx.enter(first, 210);
    const fromWidth = motion ? 0.2 : 1;
    const mask = ctx.rect(`swipe${i}`, from, cx + ex, cy + ey, w, h, h / 2, hero ? c.highlight : c.primary, {
      rz: [[from, tilt]], sx: [
        [from, fromWidth], [Math.max(settled, last.startMs), 1, "outExpo"],
        ...(ctx.exit ? [[ctx.exitAt, 1], [to, 0.06, "in"]] as const : []),
      ],
    });
    mask.origin = { dx: -w * ctx.side / 2, dy: 0 };
    mask.shadows = [{ dx: 0, dy: 8 * u, blur: 9 * u, alpha: 0.34, colour: c.shadow }];
    if (hero) mask.z = 3;
    pieces.push(mask);
    for (const cell of row) {
      const word = cue.words[cell.at]!;
      const entry = ctx.enter(word, 155);
      const [dx, dy] = rotatePoint(cell.x - (line.x1 + line.x2) / 2, inkCentre(cell) - (line.y1 + line.y2) / 2, tilt);
      const face = ctx.face(cell, entry.from, hero ? "#101014" : c.accent, {
        x: ctx.drift(entry.from, cx + dx, entry.motion ? -18 * u * ctx.side : 0, entry.settled),
        y: [[entry.from, cy + dy]], rz: [[entry.from, tilt]],
      });
      face.origin = { dx: 0, dy: inkCentre(cell) - cell.baseline };
      pieces.push(face);
    }
    if (hero) {
      pieces.push({ ...ctx.shape(`spark${i}`, from, sparklePath(sparkRadius, 0, 0, 0.24),
        { x: [[from, cx + sparkX]], y: [[from, cy + sparkY]], rz: [[from, tilt]] }, c.accent),
        stroke: { colour: c.primary, widthPx: sparkStroke / 2 }, z: 8 });
    } else if (i === 0) pieces.push({ ...ctx.dot("bullet", from, cx - (w / 2 - 27 * u) * ctx.side, cy, 9 * u, c.accent), z: 5 });
  }
  return pieces;
});
