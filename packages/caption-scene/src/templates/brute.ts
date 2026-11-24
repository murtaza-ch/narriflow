import type { DemoScript } from "../demo";
import type { Piece } from "../scene";
import { caps, galleryScene, inkCentre, letterCells, rectClip, roleRows, rowBounds, rowsOf } from "./gallery-layout";

export const BRUTE_DEMO: DemoScript = {
  lines: ["stop waiting for:m time:h@640", "nobody is:m coming:b", "money:h@620 loves:b speed:b", "so:m ship:b it:m today:h@640", "ready:b set:b go:h@520"],
  options: { rate: 215, gap: 30, cueGap: 170, tail: 620, lead: 350 },
};

const POSTER = ["#F2B21B", "#2448FF", "#FF7A1A"];

export const bruteProgram = galleryScene("brute", 1290, (ctx) => {
  const { cue, index } = ctx.window;
  const c = ctx.input.colours;
  const { cells, unit: u } = ctx.layout({ column: 920, gap: 24, padding: 66, groups: roleRows(cue, 5), words: cue.words.map((word) => {
    const hero = word.role === "hero";
    const text = caps(word, cue);
    const face = hero ? "Unbounded Black" : "Unbounded";
    const width = ctx.input.measure(text, face, 100, -0.02).advance;
    return { text, size: hero ? Math.min(410, 92000 / Math.max(1, width)) : 56, face, spacing: -0.02 };
  }) });
  const pieces: Piece[] = [];
  let heroes = ctx.input.cues.slice(0, index).reduce((sum, prior) => sum + prior.words.filter((word) => word.role === "hero").length, 0);
  let budget = 22;
  for (const [i, row] of rowsOf(cells).entries()) {
    const hero = cue.words[row[0]!.at]!.role === "hero";
    const b = rowBounds(row);
    if (!hero) {
      const start = ctx.enter(cue.words[Math.min(...row.map((cell) => cell.at))]!, 145);
      pieces.push(ctx.rect(`strip${i}`, start.from, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, b.x2 - b.x1 + 58 * u, 86 * u, 0, c.primary,
        start.motion ? { sx: [[start.from, 0.2], [start.settled, 1, "outExpo"]] } : {}));
    }
    for (const cell of row) {
      const entry = ctx.enter(cue.words[cell.at]!, hero ? 265 : 165);
      const colour = hero ? (heroes % 4 === 0 ? c.highlight : POSTER[heroes % 4 - 1]!) : c.accent;
      if (hero) heroes++;
      const parts = hero ? letterCells(cell, ctx.input, Math.min(16, budget)) : [cell];
      if (parts.length > 1) budget -= parts.length;
      for (const [j, part] of parts.entries()) {
        const from = entry.from + Math.min(j * 18, Math.max(0, entry.settled - entry.from - 24) * j / Math.max(1, parts.length - 1));
        const x = ctx.drift(from, part.x, entry.motion ? (hero ? 116 : 34) * u * ctx.side : 0, entry.settled, -90 * u * ctx.side);
        const face = ctx.face(part, from, colour, { x });
        if (parts.length > 1) face.id += `l${j}`;
        if (hero && entry.motion) {
          const bandX = ctx.space.x(540);
          face.clip = { ...rectClip(from, { x1: bandX - 460 * u, x2: bandX + 460 * u, y1: inkCentre(cell) - cell.size, y2: inkCentre(cell) + cell.size }),
            x1: [[from, bandX - 460 * u], [entry.settled - 1, bandX - 460 * u], [entry.settled, ctx.space.safe.x1 - 140 * u]],
            x2: [[from, bandX + 460 * u], [entry.settled - 1, bandX + 460 * u], [entry.settled, ctx.space.safe.x2 + 140 * u]] };
          face.track.blur = [[from, 6 * u], [entry.settled, 0, "outExpo"]];
          for (const [k, lag] of [34, 66].entries()) {
            pieces.push({ ...face, id: `${face.id}smear${k}`, z: 4, toMs: entry.settled,
              track: { ...face.track, x: ctx.drift(from, part.x, (116 + lag) * u * ctx.side, entry.settled),
                o: [[from, k ? 0.22 : 0.4], [entry.settled, 0, "outExpo"]] } });
          }
        }
        pieces.push(face);
      }
    }
  }
  return pieces;
});
