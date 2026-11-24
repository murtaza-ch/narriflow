import { toCaptionLowerCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import type { Frames, Piece } from "../scene";
import { galleryScene, inkCentre, letterCells, roleRows, rowBounds, rowsOf } from "./gallery-layout";

export const FLOWING_DEMO: DemoScript = {
  lines: ["the:m best:b ideas:b look:b stupid:b at:m first", "just:b start:h", "nobody:b is:m watching:b your:m first:b draft", "momentum:h beats:b motivation:b", "so:m ship:b it:m today:h"],
  options: { rate: 270, cueGap: 140, tail: 800 },
};

export const flowingProgram = galleryScene("flowing", 1290, (ctx) => {
  const { cue } = ctx.window;
  const c = ctx.input.colours;
  const { cells, unit: u } = ctx.layout({
    column: 840, gap: 22, padding: 58, align: "leading", groups: roleRows(cue, 8),
    words: cue.words.map((word) => {
      if (word.role !== "hero") return { text: word.text, face: "Inter Tight SemiBold", size: 62, spacing: -0.012 };
      const text = toCaptionLowerCase(word.text, cue.language);
      const width = ctx.input.measure(text, "Archivo Black", 100, -0.02).advance;
      return { text, face: "Archivo Black", size: Math.min(236, 86000 / Math.max(1, width)), spacing: -0.02 };
    }),
  });
  const pieces: Piece[] = [];
  const rows = rowsOf(cells);
  let letters = 34;
  const ordered = [...rows.filter((row) => cue.words[row[0]!.at]!.role === "hero"), ...rows.filter((row) => cue.words[row[0]!.at]!.role !== "hero")];
  const heights = ordered.map((row) => {
    const box = rowBounds(row);
    return cue.words[row[0]!.at]!.role === "hero" ? box.y2 - box.y1 + 22 * u : Math.max(100 * u, box.y2 - box.y1 + 16 * u);
  });
  const gap = 8 * u;
  let top = ctx.space.y(1290) - heights.reduce((sum, height) => sum + height, (ordered.length - 1) * gap) / 2;
  for (const [i, row] of ordered.entries()) {
    const cy = top + heights[i]! / 2;
    top += heights[i]! + gap;
    const bounds = rowBounds(row);
    const sorted = [...row].sort((a, b) => a.at - b.at);
    const hero = cue.words[sorted[0]!.at]!.role === "hero";
    if (!hero) {
      const leading = ctx.rtl ? bounds.x2 + 24 * u : bounds.x1 - 24 * u;
      const chipHeight = heights[i]!;
      const full = bounds.x2 - bounds.x1 + 48 * u;
      const edge = (cell: typeof cells[number]) => (cell.x - leading) * ctx.side + cell.width / 2 + 24 * u;
      const elapsed = sorted.map((cell) => ctx.enter(cue.words[cell.at]!, 210));
      const from = elapsed[0]!.from;
      const spans: [number, number, "outExpo"?][] = [[from, Math.min(full, edge(sorted[Math.min(1, sorted.length - 1)]!))]];
      for (let j = 1; j < sorted.length; j++) {
        const at = elapsed[j]!.from;
        if (at > spans.at(-1)![0]) spans.push([at, Math.min(full, edge(sorted[j]!)), "outExpo"]);
      }
      const sx = spans.map(([at, px, ease]) => [at, px / full, ease] as const) satisfies Frames;
      const chip = ctx.rect(`chip${i}`, from, leading, cy, full, chipHeight, 0, c.accent, { sx });
      chip.origin = { dx: -ctx.side * full / 2, dy: 0 };
      pieces.push(chip);
      const cursor = ctx.rect(`cursor${i}`, from, leading, cy, 11 * u, 80 * u, 2 * u, c.highlight, {
        x: spans.map(([at, px, ease]) => [at, leading + px * ctx.side, ease]),
      });
      cursor.z = 7;
      pieces.push(cursor);
    }
    for (const cell of row) {
      const word = cue.words[cell.at]!;
      const entry = ctx.enter(word, hero ? 245 : 150);
      const parts = hero ? letterCells(cell, ctx.input, Math.min(17, letters)) : [cell];
      if (parts.length > 1) letters -= parts.length;
      for (const [j, part] of parts.entries()) {
        const from = entry.from + Math.min(j * 20, Math.max(0, entry.settled - entry.from - 20) * j / Math.max(1, parts.length - 1));
        const face = ctx.face(part, from, hero ? c.highlight : c.primary, {
          y: ctx.drift(from, cy + (cell.baseline - inkCentre(cell)), entry.motion ? (hero ? 42 : 10) * u : 0, entry.settled, 30 * u),
        });
        if (parts.length > 1) face.id += `l${j}`;
        if (hero) face.shadows = [{ dx: 0, dy: 6 * u, blur: 9 * u, colour: c.shadow, alpha: 0.45 }];
        pieces.push(face);
      }
    }
  }
  return pieces;
});
