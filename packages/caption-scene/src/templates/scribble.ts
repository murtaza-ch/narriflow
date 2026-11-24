import type { DemoScript } from "../demo";
import type { Piece } from "../scene";
import { starPath } from "../shapes";
import { caps, galleryScene, rectClip, roleRows, rotatePoint, rowsOf } from "./gallery-layout";

export const SCRIBBLE_DEMO: DemoScript = {
  lines: ["nobody:b feels:b ready:h@540 on:m day:b one:b", "start:b messy:b", "improve:h@640 along:m the:m way:b", "ship:b it:m by:m friday:h@580", "that's:m the:m whole:b game:h@580"],
  options: { rate: 245, cueGap: 140, tail: 650, lead: 450 },
};

const PASTELS = ["#B79CFF", "#FFB27A", "#7CC8FF", "#FF9FD0", "#8EE6B8"];
const BADGES = ["!", "", "*", "", "!"];

export const scribbleProgram = galleryScene("scribble", 1290, (ctx) => {
  const { cue, index, to } = ctx.window;
  const c = ctx.input.colours;
  const { cells, unit: u } = ctx.layout({
    column: 760, padding: 64, gap: 22, groups: roleRows(cue, 4),
    words: cue.words.map((word) => ({ text: caps(word, cue), size: word.role === "hero" ? 102 : 68,
      face: word.role === "hero" ? "DM Sans Black" : "DM Sans Bold", spacing: word.role === "hero" ? 0.01 : 0.04 })),
  });
  const shade = 9 * u;
  const badgeRadius = 62 * u;
  const badgeReach = badgeRadius * 1.15;
  const badgeRise = 36 * u;
  const rows = rowsOf(cells).map((row) => {
    const strokes = row.map((cell) => {
      const hero = cue.words[cell.at]!.role === "hero";
      const turn = cell.at % 2 ? 10 : -10;
      const tilt = turn * ctx.side * (hero ? 0.55 : 1);
      const offset = turn * u * (hero ? 0.3 : 1);
      const halfInkHeight = (cell.inkBottom - cell.inkTop) / 2 + 6 * u;
      const radius = Math.max((hero ? 89 : 75) * u, halfInkHeight + 8 * u);
      // Fit the padded ink corners inside the rounded caps in the pill's own coordinates.
      const halfLength = Math.max(0, cell.width / 2 + (hero ? 42 : 60) * u - radius,
        cell.width / 2 + 8 * u - Math.sqrt(radius ** 2 - halfInkHeight ** 2));
      const [dx, dy] = rotatePoint(halfLength, 0, tilt);
      return { cell, hero, tilt, offset, radius, halfLength, reachX: dx + radius, reachY: Math.abs(dy) + radius };
    });
    const above = Math.max(...strokes.map((s) => Math.max(s.reachY - s.offset, s.hero ? badgeRise + badgeReach : 0)));
    const below = Math.max(...strokes.map((s) => s.reachY + s.offset + shade));
    return { strokes, above, below };
  });
  const gap = 6 * u;
  const height = rows.reduce((sum, row) => sum + row.above + row.below, (rows.length - 1) * gap);
  let top = ctx.space.y(1290) - height / 2;
  const pieces: Piece[] = [];
  for (const { strokes, above, below } of rows) {
    const y = top + above;
    top = y + below + gap;
    for (const { cell, hero, tilt, offset, radius, halfLength, reachX, reachY } of strokes) {
      const word = cue.words[cell.at]!;
      const { from, settled, motion } = ctx.enter(word, 190, 70);
      const cy = y + offset;
      const left = cell.x - reachX - 3 * u;
      const right = cell.x + reachX + 3 * u;
      const clip = rectClip(from, { x1: left, x2: right, y1: cy - reachY - 3 * u, y2: cy + reachY + shade + 3 * u });
      const drawnAt = Math.min(settled, word.startMs);
      if (motion && drawnAt > from) {
        if (ctx.rtl) clip.x1 = [[from, right - 0.19 * (right - left)], [drawnAt, left, "outExpo"]];
        else clip.x2 = [[from, left + 0.19 * (right - left)], [drawnAt, right, "outExpo"]];
      }
      if (ctx.exit) {
        if (ctx.rtl) clip.x2 = [...clip.x2, [ctx.exitAt, right], [to, left, "in"]];
        else clip.x1 = [...clip.x1, [ctx.exitAt, left], [to, right, "in"]];
      }
      const colour = hero ? c.highlight : PASTELS[index % PASTELS.length]!;
      const stroke = ctx.rect(`leg${cell.at}`, from, cell.x, cy, 2 * (halfLength + radius), 2 * radius, radius, colour, { rz: [[from, tilt]] });
      pieces.push({ ...stroke, clip });
      // Put all shadows under all fills, so neighbouring strokes join into a single pastel ribbon.
      pieces.push({ ...stroke, id: `${ctx.id}:shade${cell.at}`, z: 1, clip, fill: { colour: "#1A1033", alpha: 0.17 },
        track: { ...stroke.track, y: [[from, cy + shade]] } });
      const face = ctx.face(cell, from, hero ? "#FFFFFF" : c.primary, { y: [[from, cy]], rz: stroke.track.rz });
      pieces.push({ ...face, clip, origin: { dx: 0, dy: (cell.inkTop + cell.inkBottom) / 2 } });
      if (!hero) continue;
      const x = cell.x + ctx.side * (cell.width / 2 + badgeReach + 5 * u);
      const badgeY = y - badgeRise;
      const badgeAt = Math.min(word.endMs - 1, word.startMs + 70);
      const badgeEnd = Math.min(to, badgeAt + 230);
      const scale = [[badgeAt, 0.2], [badgeEnd, 1, "spring"]] as const;
      pieces.push({ ...ctx.shape(`star${cell.at}`, badgeAt, starPath(11, badgeRadius, 49 * u), {
        x: [[badgeAt, x]], y: [[badgeAt, badgeY]], sx: scale, sy: scale,
      }, c.accent), z: 8, shadows: [{ dx: 0, dy: 7 * u, blur: 0, alpha: 0.17, colour: "#1A1033" }] });
      const mark = BADGES[index % BADGES.length];
      if (mark) {
        const sizePx = 78 * u;
        const metric = ctx.input.measure(mark, cell.face, sizePx, cell.spacing);
        pieces.push({
          ...ctx.face(cell, badgeAt, "#1A1033", { x: [[badgeAt, x]], y: [[badgeAt, badgeY]], sx: scale, sy: scale }),
          id: `${ctx.id}:badge${cell.at}`, z: 9, text: mark, sizePx, origin: { dx: 0, dy: (metric.inkTop + metric.inkBottom) / 2 },
        });
      }
    }
  }
  return pieces;
});
