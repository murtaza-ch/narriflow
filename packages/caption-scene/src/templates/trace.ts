import type { DemoScript } from "../demo";
import type { Piece } from "../scene";
import { sparklePath } from "../shapes";
import { caps, galleryScene, inkCentre, letterCells, rectClip, roleRows, rowsOf } from "./gallery-layout";

export const TRACE_DEMO: DemoScript = {
  lines: ["most:b rules:b are:m just:m fear:h", "nobody:b remembers:b the:m safe:b ones", "go:b big:h or:m go:b home", "so:m be:b loud:h"],
  options: { rate: 280, cueGap: 140, tail: 800 },
};

export const traceProgram = galleryScene("trace", 1290, (ctx) => {
  const { cue, to } = ctx.window;
  const c = ctx.input.colours;
  const { cells, unit: u } = ctx.layout({
    column: 810, gap: 25, padding: 76, groups: roleRows(cue, 4),
    words: cue.words.map((word) => ({ text: caps(word, cue), face: word.role === "hero" ? "Unbounded Black" : "Barlow Condensed ExtraBold Italic",
      size: word.role === "hero" ? 168 : 150, spacing: word.role === "hero" ? -0.02 : 0.005 })),
  });
  const pieces: Piece[] = [];
  const rows = rowsOf(cells);
  let budget = 28;
  for (const cell of cells) {
    const word = cue.words[cell.at]!;
    const hero = word.role === "hero";
    const { from, settled, motion } = ctx.enter(word, hero ? 300 : 185, 50);
    const y = inkCentre(cell);
    const base = ctx.face(cell, from, c.primary);
    if (hero) {
      const parts = letterCells(cell, ctx.input, Math.min(17, budget));
      if (parts.length > 1) budget -= parts.length;
      for (const [j, part] of parts.entries()) {
        const at = from + Math.min(34 * j, Math.max(0, settled - from - 28) * j / Math.max(1, parts.length - 1));
        const scale = motion ? [[at, 0.22], [settled, 1, "outBack"]] as const : [[at, 1]] as const;
        const letter = ctx.face(part, at, c.primary, { y: ctx.drift(at, y, motion ? 39 * u : 0, settled), sx: scale, sy: scale });
        if (parts.length > 1) letter.id += `l${j}`;
        letter.origin = { dx: 0, dy: y - cell.baseline };
        pieces.push({ ...letter, id: `${letter.id}rim`, z: 3, stroke: { colour: c.primary, widthPx: 18 * u } });
        pieces.push({ ...letter, id: `${letter.id}gap`, z: 4, stroke: { colour: c.accent, widthPx: 7.5 * u } });
        pieces.push(letter);
      }
      // The badge sits on the hero's top corner, between the rows. Ink that hangs below the row above's baseline (Devanagari
      // matras and tails) would be covered, so the badge keeps the Latin clearance to that measured ink: it drops by the
      // overhang and moves out beside the word rather than over its first letters.
      const badgeR = 42 * u;
      const above = rows[rows.findIndex((row) => row.includes(cell)) - 1] ?? [];
      const hang = Math.max(0, ...above.map((other) => other.inkBottom - ctx.input.measure("O", other.face, other.size, other.spacing).inkBottom));
      const by = y - cell.size * 0.45 + hang;
      const x = cell.x + (cell.width / 2 + (hang > 0 ? 4 * u + badgeR : 12 * u)) * ctx.side;
      const badgeAt = Math.min(word.startMs + 200, word.endMs - 1);
      const badgeEnd = Math.min(to, badgeAt + 280);
      const scale = [[badgeAt, 0.15], [badgeEnd, 1, "outBack"]] as const;
      pieces.push({ ...ctx.dot(`badge${cell.at}`, badgeAt, x, by, 42 * u, c.primary, { sx: scale, sy: scale }), z: 8, stroke: { colour: c.accent, widthPx: 5 * u } });
      pieces.push({ ...ctx.shape(`star${cell.at}`, badgeAt, sparklePath(31 * u, 0, 0, 0.26), {
        x: [[badgeAt, x]], y: [[badgeAt, by]], rz: [[badgeAt, -160], [badgeEnd, 25, "outBack"]], sx: scale, sy: scale,
      }, c.accent), z: 9 });
      continue;
    }
    base.stroke = { colour: c.primary, widthPx: 2 * u };
    base.fillAlpha = 0;
    pieces.push(base);
    const next = cue.words[cell.at + 1];
    const wipeFrom = next?.startMs ?? to;
    const end = Math.min(to, wipeFrom + 140);
    const x1 = cell.x - cell.width / 2 - 8 * u;
    const x2 = cell.x + cell.width / 2 + 8 * u;
    const clip = rectClip(from, { x1, x2, y1: cell.baseline + cell.inkTop - 9 * u, y2: cell.baseline + cell.inkBottom + 9 * u });
    if (next) {
      if (ctx.rtl) clip.x2 = [[from, x2], [wipeFrom, x2], [end, x1, "outExpo"]];
      else clip.x1 = [[from, x1], [wipeFrom, x1], [end, x2, "outExpo"]];
    }
    pieces.push({ ...base, id: `${base.id}solid`, z: 7, toMs: end, fillAlpha: 1, stroke: undefined, clip,
      shadows: [{ dx: 0, dy: 4 * u, blur: 4 * u, colour: c.shadow, alpha: 0.5 }] });
  }
  return pieces;
});
