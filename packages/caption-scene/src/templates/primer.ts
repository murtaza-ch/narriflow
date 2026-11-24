import type { DemoScript } from "../demo";
import type { Piece } from "../scene";
import { polygonPath, polylinePath } from "../shapes";
import { caps, galleryScene, inkCentre, roleRows } from "./gallery-layout";

export const PRIMER_DEMO: DemoScript = {
  lines: ["learn:b the:m basics:h@600", "then:b break:b the:m rules:h@560", "never:h@620 stop:b asking:b why:b", "and:m keep:b it:m simple:b", "small:b steps:b win:h@640"],
  options: { rate: 250, gap: 24, cueGap: 150, tail: 760, lead: 350 },
};

const INK = "#15151A";
const GREEN = "#2DB34A";
const CROSS = polylinePath([[-17, 0], [17, 0], [0, 0], [0, -17], [0, 17]]);

export const primerProgram = galleryScene("primer", 1300, (ctx) => {
  const { cue, index } = ctx.window;
  const colours = ctx.input.colours;
  const hasHero = cue.words.some((word) => word.role === "hero");
  const { cells, unit: u, box } = ctx.layout({
    words: cue.words.map((word) => ({ text: caps(word, cue), face: "Archivo Black", size: word.role === "hero" ? 216 : hasHero ? 78 : 92, spacing: -0.025 })),
    column: 888, gap: 20, padding: 80, align: "leading", groups: roleRows(cue, 4),
  });
  const edge = ctx.space.x(ctx.rtl ? 984 : 96);
  const dx = ctx.rtl ? edge - box.x2 : edge - box.x1;
  const pieces: Piece[] = [];
  let heroIndex = ctx.input.cues.slice(0, index).reduce((count, item) => count + item.words.filter((word) => word.role === "hero").length, 0);
  for (const measured of cells) {
    const cell = { ...measured, x: measured.x + dx };
    const word = cue.words[cell.at]!;
    const { from, settled, motion } = ctx.enter(word, 240);
    const x = cell.x;
    const cy = inkCentre(cell);
    const face = ctx.face(cell, from, colours.primary, { x: ctx.drift(from, x, motion ? 150 * u * ctx.side : 0, settled, -110 * u * ctx.side) });
    pieces.push({
      ...face, stroke: { colour: INK, widthPx: 4.5 * u },
      shadows: [{ dx: 0, dy: cell.size * 0.07, blur: 0, alpha: 1, colour: INK }],
    });
    if (word.role !== "hero") continue;
    const variant = heroIndex++ % 4;
    const scale = motion ? [[from, 0.12], [settled, 1, "outExpo"]] as const : [[from, 1]] as const;
    if (variant % 2 === 0) {
      const r = Math.min(280 * u, Math.max(cell.size * 0.95, cell.width * 0.35));
      pieces.push(ctx.dot(`disk${cell.at}`, from, x, cy, r, variant === 0 ? colours.highlight : colours.accent, { sx: scale, sy: scale }));
      const dotOn = Math.min(word.endMs - 1, from + 160);
      const dotScale = [[dotOn, 0.08], [Math.min(ctx.window.to, dotOn + 180), 1, "spring"]] as const;
      pieces.push(ctx.dot(`dot${cell.at}`, dotOn, x - ctx.side * r, cy + r * 0.72, r * 0.26, variant === 0 ? colours.accent : colours.highlight, { sx: dotScale, sy: dotScale }));
    } else {
      pieces.push(ctx.rect(`bar${cell.at}`, from, x, cy + cell.size * 0.28, cell.width + 44 * u, cell.size * 0.34, 0, "#E03030", { sx: scale }));
      pieces.push(ctx.shape(`triangle${cell.at}`, from, polygonPath([[0, -28 * u], [28 * u, 22 * u], [-28 * u, 22 * u]]),
        { x: [[from, x + ctx.side * cell.width / 2]], y: [[from, cy - cell.size * 0.4]], sx: scale, sy: scale }, GREEN));
    }
    for (const [j, offset, y, colour] of [
      [0, 0.49, -0.82, colours.accent], [1, 0.53, 0.42, variant % 2 ? colours.highlight : "#E03030"], [2, -0.38, 0.62, GREEN],
    ] as const) {
      const markOn = Math.min(word.endMs - 1, from + 140 + j * 80);
      const scale = [[markOn, 0.08 * u], [Math.min(ctx.window.to, markOn + 180), u, "spring"]] as const;
      pieces.push({ ...ctx.shape(`cross${cell.at}-${j}`, markOn, CROSS, {
        x: [[markOn, x + offset * cell.width * ctx.side]], y: [[markOn, cy + y * cell.size]],
        sx: scale, sy: scale, rz: [[markOn, j === 1 ? 45 : 0]],
      }), stroke: { colour, widthPx: 9 }, z: 4 });
    }
  }
  if (!hasHero) {
    const from = ctx.window.from;
    pieces.push(ctx.rect("tab", from, edge + 84 * u * ctx.side, box.y1 - 28 * u, 168 * u, 18 * u, 0, "#E03030"));
    pieces.push(ctx.dot("dot", from, (ctx.rtl ? box.x1 : box.x2) + dx + 44 * u * ctx.side, inkCentre(cells.at(-1)!), 23 * u, colours.accent));
  }
  return pieces;
});
