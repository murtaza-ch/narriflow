import type { DemoScript } from "../demo";
import type { Piece } from "../scene";
import { caps, galleryScene, inkCentre, roleRows, rotatePoint, rowBounds, rowsOf } from "./gallery-layout";

export const CROSSTAPE_DEMO: DemoScript = {
  lines: ["nobody is:m coming to:m save you:h@520", "less talking more doing", "post before:m you:m feel ready:h@560", "keep going", "small steps win:h@520"],
  options: { rate: 225, gap: 30, cueGap: 170, tail: 650, lead: 350 },
};

export const crosstapeProgram = galleryScene("crosstape", 1296, (ctx) => {
  const { cue, to } = ctx.window;
  const c = ctx.input.colours;
  const hasHero = cue.words.some((word) => word.role === "hero");
  const groups = roleRows(cue, 9).flatMap((row) => {
    if (row.length <= 1 || (!hasHero && row.length <= 2)) return [row];
    const first = row.length === 2 ? 1 : 2;
    return [row.slice(0, first), row.slice(first)];
  });
  const { cells, unit: u } = ctx.layout({ column: 670, gap: 17, padding: 118, groups,
    words: cue.words.map((word) => {
      const text = word.role === "hero" ? caps(word, cue) : word.text;
      const size = word.role === "hero" ? Math.min(104, 22200 / Math.max(1, ctx.input.measure(text, "Inter Tight ExtraBold", 100, -0.012).advance)) : 62;
      return { text, size,
        face: word.role === "hero" ? "Inter Tight ExtraBold" : "Inter Tight SemiBold", spacing: -0.012 };
    }),
  });
  const rows = rowsOf(cells);
  const plainRows = rows.filter((row) => cue.words[row[0]!.at]!.role !== "hero");
  const pieces: Piece[] = [];
  const crossX = ctx.space.x(540) + 190 * u * ctx.side;
  const crossY = ctx.space.y(1296);
  for (const [i, row] of rows.entries()) {
    const hero = cue.words[row[0]!.at]!.role === "hero";
    const b = rowBounds(row);
    const tilt = (plainRows.length <= 1 ? (hero ? -13 : -5) : hero || plainRows.indexOf(row) % 2 ? -13 : 11) * ctx.side;
    const cross = plainRows.length === 2 && !hero;
    const extra = cross ? (i === 0 ? 230 : 190) * u : 0;
    const inkW = b.x2 - b.x1;
    const h = (hero ? 118 : 96) * u;
    const w = inkW + 56 * u + extra;
    const lineX = (b.x1 + b.x2) / 2;
    const lineY = (b.y1 + b.y2) / 2;
    const [dx, dy] = rotatePoint(-(inkW / 2 + extra - 32 * u) * ctx.side, 0, tilt);
    const [tagX, tagY] = rotatePoint((w / 2 - 10 * u) * ctx.side, 0, tilt);
    const cx = cross ? crossX + dx : hero && plainRows.length === 2 ? crossX + tagX : lineX;
    const cy = cross ? crossY + dy : hero && plainRows.length === 2 ? crossY + tagY : lineY + (i - (rows.length - 1) / 2) * 28 * u;
    const plateCentreX = cx + Math.cos(tilt * Math.PI / 180) * extra * ctx.side / 2;
    const plateCentreY = cy + Math.sin(tilt * Math.PI / 180) * extra * ctx.side / 2;
    const word = cue.words[Math.min(...row.map((cell) => cell.at))]!;
    const entry = ctx.enter(word, 236);
    const end = Math.max(entry.settled, ...row.map((cell) => cue.words[cell.at]!.startMs));
    const [ex, ey] = rotatePoint(-w / 2 * ctx.side, 0, tilt);
    const fill = hero ? "#0E0E10" : i % 2 === 0 ? c.highlight : c.accent;
    const tape = ctx.rect(`tape${i}`, entry.from, plateCentreX + ex, plateCentreY + ey, w, h, 0, fill, {
      rz: [[entry.from, tilt]], sx: [[entry.from, entry.motion ? 0.27 : 1], [end, 1, "outExpo"],
        ...(ctx.exit ? [[ctx.exitAt, 1], [to, 0.06, "in"]] as const : [])],
    });
    tape.origin = { dx: -w / 2 * ctx.side, dy: 0 };
    tape.z = 2 + i;
    tape.shadows = [{ dx: 0, dy: 7 * u, blur: 6 * u, alpha: 0.3, colour: c.shadow }];
    pieces.push(tape);
    for (const cell of row) {
      const { from, motion, settled } = ctx.enter(cue.words[cell.at]!, 206);
      const [rx, ry] = rotatePoint(cell.x - lineX, inkCentre(cell) - lineY, tilt);
      const face = ctx.face(cell, from, hero ? c.highlight : c.primary, {
        x: ctx.drift(from, cx + rx, motion ? -20 * u * ctx.side : 0, settled),
        y: [[from, cy + ry]], rz: [[from, tilt]],
      });
      face.z = 32 + i;
      face.origin = { dx: 0, dy: inkCentre(cell) - cell.baseline };
      pieces.push(face);
    }
  }
  return pieces;
});
