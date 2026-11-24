import { toCaptionLowerCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import type { Frames, Piece } from "../scene";
import { galleryScene, inkCentre, letterCells, rowBounds, rowsOf } from "./gallery-layout";

export const FLOWING_DEMO: DemoScript = {
  lines: ["the:m best:b ideas:b look:b stupid:b at:m first", "just:b start:h", "nobody:b is:m watching:b your:m first:b draft", "momentum:h beats:b motivation:b", "so:m ship:b it:m today:h"],
  options: { rate: 270, cueGap: 140, tail: 800 },
};

export const flowingProgram = galleryScene("flowing", 1290, (ctx) => {
  const { cue } = ctx.window;
  const c = ctx.input.colours;
  const heroes = cue.words.flatMap((word, at) => word.role === "hero" ? [at] : []);
  // Key words sit on top, each alone. Every other word, before or after a key word, goes in one
  // chip in spoken order, so the chips read left to right, top to bottom.
  const chipWords = cue.words.flatMap((word, at) => word.role === "hero" ? [] : [at]);
  const { cells, unit: u } = ctx.layout({
    column: 840, gap: 22, padding: 58, align: "leading",
    groups: [...heroes.map((at) => [at]), ...(chipWords.length ? [chipWords] : [])],
    words: cue.words.map((word) => {
      if (word.role !== "hero") return { text: word.text, face: "Inter Tight SemiBold", size: 62, spacing: -0.012 };
      const text = toCaptionLowerCase(word.text, cue.language);
      const width = ctx.input.measure(text, "Archivo Black", 100, -0.02).advance;
      return { text, face: "Archivo Black", size: Math.min(236, 86000 / Math.max(1, width)), spacing: -0.02 };
    }),
  });
  const pieces: Piece[] = [];
  const ordered = rowsOf(cells);
  let letters = 34;
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
    // A chip grows to each word's right end as that word is spoken, like the sample's typing edge.
    const leading = ctx.rtl ? bounds.x2 + 24 * u : bounds.x1 - 24 * u;
    const edgeOf = (cell: typeof cells[number]) => (cell.x - leading) * ctx.side + cell.width / 2 + 24 * u;
    if (!hero) {
      const chipHeight = heights[i]!;
      const full = bounds.x2 - bounds.x1 + 48 * u;
      const elapsed = sorted.map((cell) => ctx.enter(cue.words[cell.at]!, 360, 90));
      const from = elapsed[0]!.from;
      const sliver = 14 * u;
      const widths: [number, number, "outExpo"?][] = [[from, sliver]];
      let reached = sliver;
      for (const [j, cell] of sorted.entries()) {
        const { from: at, settled } = elapsed[j]!;
        const target = Math.min(full, edgeOf(cell));
        if (at > widths.at(-1)![0]) widths.push([at, reached]);
        widths.push(settled > widths.at(-1)![0] ? [settled, target, "outExpo"] : [widths.at(-1)![0] + 1, target]);
        reached = target;
      }
      const sx = widths.map(([at, px, ease]) => [at, px / full, ease] as const) satisfies Frames;
      const y = ctx.drift(from, cy, 0, from, 30 * u);
      const chip = ctx.rect(`chip${i}`, from, leading, cy, full, chipHeight, 3 * u, c.accent, { sx, y });
      chip.origin = { dx: -ctx.side * full / 2, dy: 0 };
      pieces.push(chip);
      const cursor = ctx.rect(`cursor${i}`, from, leading, cy, 8 * u, 72 * u, 0, c.highlight, {
        x: widths.map(([at, px, ease]) => [at, leading + (px - 4 * u) * ctx.side, ease]),
        y,
      });
      cursor.z = 7;
      cursor.toMs = Math.min(cursor.toMs, Math.max(from + 1, cue.words[sorted.at(-1)!.at]!.endMs + 120));
      pieces.push(cursor);
    }
    for (const cell of row) {
      const word = cue.words[cell.at]!;
      const entry = hero ? ctx.enter(word, 245) : ctx.enter(word, 240, 85);
      const parts = hero ? letterCells(cell, ctx.input, Math.min(17, letters)) : [cell];
      if (parts.length > 1) letters -= parts.length;
      for (const [j, part] of parts.entries()) {
        const from = entry.from + Math.min(j * 20, Math.max(0, entry.settled - entry.from - 20) * j / Math.max(1, parts.length - 1));
        const face = ctx.face(part, from, hero ? c.highlight : c.primary, {
          y: ctx.drift(from, cy + (cell.baseline - inkCentre(cell)), hero && entry.motion ? 42 * u : 0, entry.settled, 30 * u),
        });
        if (parts.length > 1) face.id += `l${j}`;
        if (hero) face.shadows = [{ dx: 0, dy: 6 * u, blur: 9 * u, colour: c.shadow, alpha: 0.45 }];
        else {
          // The word is wiped in from its leading edge behind the chip edge, never drawn ahead of the chip.
          const left = cell.x - cell.width / 2;
          const right = cell.x + cell.width / 2;
          const wiped = entry.settled > entry.from;
          // The wipe opens on a stub of the word so a word with no lead still paints at its spoken start.
          const stub = 0.12 * (right - left);
          const sweep = (a: number, b: number): Frames => wiped ? [[from, a], [entry.settled, b, "out"]] : [[from, b]];
          face.clip = {
            x1: ctx.rtl ? sweep(right - stub, left) : [[from, left]],
            x2: ctx.rtl ? [[from, right]] : sweep(left + stub, right),
            y1: [[from, cy - cell.size * 2]], y2: [[from, cy + cell.size * 2]],
          };
        }
        pieces.push(face);
      }
    }
  }
  return pieces;
});
