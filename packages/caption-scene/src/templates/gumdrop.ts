import type { DemoScript } from "../demo";
import { paintedFrameCount } from "../frame-grid";
import type { Piece } from "../scene";
import { sparklePath } from "../shapes";
import { caps, galleryScene, inkCentre, roleRows, rowsOf } from "./gallery-layout";

export const GUMDROP_DEMO: DemoScript = {
  lines: ["ok:m this:b one:b is:m gold:h@1100", "you:m got:b this:b champ:h@1100", "stay weird:h@1100", "that's a:m wrap"],
  options: { rate: 235, gap: 30, cueGap: 170, tail: 800, lead: 350 },
};

const THEMES = [
  ["#FFD21E", "#F48FD9", "#1E9BE8", "#F15A0C"],
  ["#F15A0C", "#FFD21E", "#1E9BE8", "#F48FD9"],
  ["#F48FD9", "#FFD21E", "#18B21E", "#1E9BE8"],
  ["#1E9BE8", "#FFD21E", "#F48FD9", "#18B21E"],
] as const;

export const gumdropProgram = galleryScene("gumdrop", 1290, (ctx) => {
  const { cue, index, to } = ctx.window;
  const c = ctx.input.colours;
  const ink = c.accent;
  const theme = THEMES[index % THEMES.length]!;
  const hasHero = cue.words.some((word) => word.role === "hero");
  const { cells, unit: u } = ctx.layout({
    column: 860, gap: 38, padding: 87, groups: roleRows(cue, 2),
    words: cue.words.map((word) => ({ text: caps(word, cue), face: "Bagel Fat One",
      size: word.role === "hero" ? 206 : 150, spacing: 0.005 })),
  });
  const rows = rowsOf(cells);
  const heroRow = rows.findIndex((row) => cue.words[row[0]!.at]!.role === "hero");
  const rowHeight = rows.map((row) => Math.max(...row.map((cell) => cell.inkBottom - cell.inkTop + 0.28 * cell.size)));
  const rowCentre: number[] = [];
  if (hasHero) {
    rowCentre[heroRow] = ctx.space.y(1290) - 52 * u;
    for (let i = heroRow - 1; i >= 0; i--) rowCentre[i] = rowCentre[i + 1]! - (rowHeight[i]! + rowHeight[i + 1]!) / 2;
    // Words spoken after the key word sit right under it: its copies fold back before the first of them appears.
    for (let i = heroRow + 1; i < rows.length; i++) rowCentre[i] = rowCentre[i - 1]! + (rowHeight[i - 1]! + rowHeight[i]!) / 2;
  }
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const tailFrom = heroAt < 0 ? Infinity : Math.min(Infinity, ...cue.words.slice(heroAt + 1).map((word) => ctx.enter(word, 230).from));
  const centreOf = (cell: (typeof cells)[number]) => rowCentre[rows.findIndex((row) => row.includes(cell))] ?? inkCentre(cell);
  const pieces: Piece[] = [];
  for (const cell of cells) {
    const word = cue.words[cell.at]!;
    const hero = word.role === "hero";
    const { from, settled, motion } = ctx.enter(word, 230);
    const y = centreOf(cell);
    const sx = motion ? [[from, 0.5], [settled, 1, "outBack"]] as const : [[from, 1]] as const;
    const base = ctx.face(cell, from, hero ? (index % THEMES.length ? theme[0] : c.highlight) : hasHero ? c.primary : theme[3], {
      y: ctx.drift(from, y, motion ? 19 * u : 0, settled, 34 * u), rz: [[from, -6 * ctx.side]], sx, sy: sx,
    });
    base.origin = { dx: 0, dy: (cell.inkTop + cell.inkBottom) / 2 };
    base.stroke = { colour: ink, widthPx: cell.size * 0.065 };
    base.shadows = [{ dx: cell.size * 0.05, dy: cell.size * 0.062, blur: 0, colour: ink, alpha: 1 }];
    pieces.push(base);
    if (!hero) continue;
    const foldIn = Math.min(word.startMs + 130, settled);
    const foldOut = Math.min(to, word.endMs + 110, tailFrom);
    if (paintedFrameCount(foldIn, foldOut, ctx.fps) < 3) continue;
    const span = foldOut - foldIn;
    for (let j = 1; j < 4; j++) {
      const rise = j * cell.size * 0.4;
      pieces.push({ ...base, id: `${base.id}copy${j}`, z: 5 - j, fromMs: foldIn, toMs: foldOut, fill: theme[j]!,
        track: { x: [[foldIn, cell.x]], y: [[foldIn, y], [foldIn + span * 0.29, y + rise, "outBack"],
          [foldIn + span * 0.6, y + rise], [foldOut, y, "inOut"]], rz: [[foldIn, -6 * ctx.side]] } });
    }
    // The spark sits on whichever corner of the key word no other word reaches.
    const reach = 37 * u * 1.1;
    const sparkAt = [[1, -1], [-1, -1], [1, 1], [-1, 1]].map(([sx0, sy0]) => ({
      x: cell.x + (cell.width / 2 + 16 * u) * ctx.side * sx0!, y: y + 95 * u * sy0!,
    })).map((spot) => ({ ...spot, hit: cells.filter((other) => other !== cell).reduce((sum, other) => {
      const tilt = (other.width / 2) * Math.sin(6 * Math.PI / 180) + 4 * u;
      const half = (other.inkBottom - other.inkTop) / 2 + tilt;
      const dx = Math.min(spot.x + reach, other.x + other.width / 2) - Math.max(spot.x - reach, other.x - other.width / 2);
      const dy = Math.min(spot.y + reach, centreOf(other) + half) - Math.max(spot.y - reach, centreOf(other) - half);
      return sum + (dx > 0 && dy > 0 ? dx * dy : 0);
    }, 0) })).reduce((best, spot) => (spot.hit < best.hit ? spot : best));
    pieces.push({ ...ctx.shape(`spark${cell.at}`, foldIn, sparklePath(37 * u), {
      x: [[foldIn, sparkAt.x]], y: [[foldIn, sparkAt.y]],
      sx: [[foldIn, 0.4], [foldIn + span * 0.26, 1, "outBack"]],
      sy: [[foldIn, 0.4], [foldIn + span * 0.26, 1, "outBack"]],
    }, theme[1]), stroke: { colour: ink, widthPx: 5 * u }, z: 9 });
  }
  return pieces;
});
