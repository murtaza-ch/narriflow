import type { DemoScript } from "../demo";
import type { Piece } from "../scene";
import { sparklePath } from "../shapes";
import { caps, galleryScene, inkCentre, letterCells, roleRows } from "./gallery-layout";

export const DIECUT_DEMO: DemoScript = {
  lines: ["start:b before you:m are:m ready:h@560", "perfect:b is:m a:m myth:h@520", "done:b beats perfect:b@460", "post:b it:m today:h@560", "go:h@560"],
  options: { rate: 215, gap: 40, cueGap: 200, tail: 620, lead: 320 },
};

const NAVY = "#1C1A5E";
const FILLS = ["#FF5FA2", "#7FDB3F", "#3FB8FF", "#B388FF"];

export const diecutProgram = galleryScene("diecut", 1290, (ctx) => {
  const { cue, index } = ctx.window;
  const c = ctx.input.colours;
  const groups = roleRows(cue, 2);
  const words = cue.words.map((word) => ({ text: caps(word, cue), face: "Titan One" as const, size: word.role === "hero" ? 260 : 108, spacing: 0.012 }));
  for (const row of groups) {
    const gaps = 38 * (row.length - 1);
    const width = row.reduce((sum, at) => {
      const { text, face, size, spacing } = words[at]!;
      return sum + ctx.input.measure(text, face, size, spacing).advance;
    }, 0);
    const fit = Math.min(1, (830 - gaps) / Math.max(1, width));
    for (const at of row) words[at]!.size *= fit;
  }
  const { cells, unit: u } = ctx.layout({ column: 862, padding: 86, gap: 38, groups, words });
  const pieces: Piece[] = [];
  let letterBudget = 24;
  for (const cell of cells) {
    const word = cue.words[cell.at]!;
    const hero = word.role === "hero";
    const entry = ctx.enter(word, hero ? 275 : 205);
    const letters = hero ? letterCells(cell, ctx.input, Math.min(14, letterBudget)) : [cell];
    if (letters.length > 1) letterBudget -= letters.length;
    const turned = index % 5 === 0 ? c.highlight : FILLS[index % 5 - 1]!;
    for (const [i, part] of letters.entries()) {
      const delay = Math.min(20 * i, Math.max(0, entry.settled - entry.from - 35) * i / Math.max(1, letters.length - 1));
      const from = entry.from + delay;
      const tintAt = Math.min(word.endMs - 1, from + 300);
      const centre = inkCentre(cell);
      const sz = entry.motion ? [[from, hero ? 0.58 : 0.64], [entry.settled, 1, "outBack"]] as const : [[from, 1]] as const;
      const base = ctx.face(part, from, c.primary, {
        y: ctx.drift(from, centre, entry.motion ? 18 * u : 0, entry.settled, -22 * u),
        sx: sz, sy: hero && entry.motion ? [[from, 0.44], [entry.settled, 1, "outBack"]] : sz,
        rz: [[from, ((hero ? [-4, 3, -2, 4, -3][i % 5]! : -1.6) + (cell.at % 2)) * ctx.side]],
        ...(hero ? { colour: [[from, c.primary], [tintAt, c.primary], [Math.min(ctx.window.to, tintAt + 200), turned, "out"]] } : {}),
      });
      if (letters.length > 1) base.id += `l${i}`;
      base.origin = { dx: 0, dy: centre - cell.baseline };
      pieces.push({ ...base, id: `${base.id}border`, z: 2, stroke: { colour: c.primary, widthPx: cell.size * 0.16 }, track: { ...base.track, colour: undefined },
        shadows: [{ dx: 0, dy: 11 * u, blur: 8 * u, alpha: 0.38, colour: NAVY }] });
      pieces.push({ ...base, id: `${base.id}depth`, z: 3, fill: NAVY, stroke: { colour: NAVY, widthPx: cell.size * 0.053 },
        origin: { dx: 0, dy: base.origin.dy - 8 * u }, track: { ...base.track, colour: undefined } });
      pieces.push({ ...base, stroke: { colour: NAVY, widthPx: cell.size * 0.048 } });
    }
    if (hero) {
      for (const [j, side] of [-1, 1].entries()) {
        const from = Math.min(entry.settled, entry.from + 120 + j * 60);
        pieces.push({ ...ctx.shape(`spark${cell.at}-${j}`, from, sparklePath((j ? 23 : 34) * u), {
          x: [[from, cell.x + side * cell.width / 2 * ctx.side]], y: [[from, inkCentre(cell) + side * cell.size * 0.36]],
        }, c.primary), stroke: { colour: NAVY, widthPx: 3 * u }, z: 9 });
      }
    }
  }
  return pieces;
});
