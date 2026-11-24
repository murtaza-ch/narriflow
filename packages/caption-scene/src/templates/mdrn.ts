import type { DemoScript } from "../demo";
import type { Piece } from "../scene";
import { caps, galleryScene, inkCentre, rectClip, roleRows, rowBounds, rowsOf } from "./gallery-layout";

export const MDRN_DEMO: DemoScript = {
  lines: ["great taste feels:m simple:h@600", "less is:m more", "people remember how:m it:m felt:h@560", "make it:m yours:h@560", "start today:h@600"],
  options: { rate: 235, gap: 30, cueGap: 170, tail: 620, lead: 350 },
};

export const mdrnProgram = galleryScene("mdrn", 1290, (ctx) => {
  const { cue } = ctx.window;
  const c = ctx.input.colours;
  const pillAt = cue.words.findIndex((word) => word.role === "minor");
  const groupAfterPill = cue.words.map((_, at) => at).slice(pillAt);
  const groups = pillAt > 0
    ? [...Array.from({ length: Math.ceil(pillAt / 2) }, (_, i) => [i * 2, i * 2 + 1].filter((at) => at < pillAt)), groupAfterPill]
    : roleRows(cue, 2);
  const words = cue.words.map((word, at) => ({
    text: caps(word, cue), size: at === pillAt ? 53.6 : word.role === "hero" ? 171.5 : word.role === "minor" ? 67 : 134,
    face: at === pillAt ? "Archivo Expanded ExtraBold" as const : "Archivo Expanded Black" as const,
    spacing: at === pillAt ? 0.06 : -0.012,
  }));
  const fit = Math.min(1, ...groups.map((row) => 754 / row.reduce((sum, at) => {
    const { text, face, size, spacing } = words[at]!;
    return sum + ctx.input.measure(text, face, size, spacing).advance;
  }, 31 * (row.length - 1))));
  const { cells, box, unit: u } = ctx.layout({
    column: 755, gap: 31 * fit, padding: 85, align: "leading", groups,
    words: words.map((word) => ({ ...word, size: word.size * fit })),
  });
  const edge = ctx.space.x(ctx.rtl ? 990 : 90);
  const dx = edge - (ctx.rtl ? box.x2 : box.x1);
  const pieces: Piece[] = [];
  for (const [i, row] of rowsOf(cells).entries()) {
    const b = rowBounds(row);
    const shift = dx + (i > 0 ? 70 * u * fit * ctx.side : 0);
    for (const measured of row) {
      const cell = { ...measured, x: measured.x + shift };
      const word = cue.words[cell.at]!;
      const { from, settled, motion } = ctx.enter(word, 260);
      const travel = motion ? Math.min(cell.size * 0.49, (cell.inkBottom - cell.inkTop) * 0.8) : 0;
      const shown = ctx.face(cell, from, c.primary, { y: ctx.drift(from, cell.baseline, travel, settled, -40 * u) });
      if (cell.at === pillAt) {
        const cy = inkCentre(cell);
        const pillX = cell.x - 14 * u * fit * ctx.side;
        shown.track.x = [[from, pillX]];
        pieces.push({ ...ctx.rect("pill", from, pillX, cy, cell.width + 55 * u * fit, 86 * u * fit, 40 * u * fit, c.primary, { y: ctx.drift(from, cy, travel, settled, -40 * u) }),
          fill: undefined, stroke: { colour: c.primary, widthPx: 2 * u } });
      } else {
        shown.clip = rectClip(from, { x1: cell.x - cell.width / 2 - 12 * u, x2: cell.x + cell.width / 2 + 12 * u,
          y1: cell.baseline + cell.inkTop - 44 * u, y2: cell.baseline + cell.inkBottom + 2 * u });
        shown.shadows = [{ dx: 0, dy: 4 * u, blur: 7 * u, alpha: 0.5, colour: c.shadow }];
      }
      pieces.push(shown);
      if (word.role === "hero") {
        const x = cell.x + (cell.width / 2 + 25 * u) * ctx.side;
        const y = cell.baseline - cell.size * 0.35;
        pieces.push({ ...ctx.face(cell, from, c.highlight, { x: [[from, x]], y: ctx.drift(from, y, motion ? -58 * u : 0, settled, -40 * u) }),
          id: `${ctx.id}:asterisk${cell.at}`, z: 8, text: "*", sizePx: cell.size * 0.9 });
      }
    }
    if (i === 0) {
      const word = cue.words[Math.max(...row.map((cell) => cell.at))]!;
      const { from, settled, motion } = ctx.enter(word, 230, 20);
      pieces.push(ctx.rect("dash", from, (ctx.rtl ? b.x1 : b.x2) + shift + 55 * u * ctx.side, (b.y1 + b.y2) / 2, 83 * u, 13 * u, 0, c.highlight,
        motion ? { sx: [[from, 0.1], [settled, 1, "outExpo"]] } : {}));
    }
  }
  return pieces;
});
