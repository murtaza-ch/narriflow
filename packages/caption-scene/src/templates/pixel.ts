import type { DemoScript } from "../demo";
import type { Frames } from "../ease";
import { paintedFrameCount } from "../frame-grid";
import type { Piece } from "../scene";
import { polygonPath, polylinePath, sparklePath } from "../shapes";
import { caps, galleryScene, inkCentre, roleRows, rotatePoint, rowBounds, rowsOf } from "./gallery-layout";

export const PIXEL_DEMO: DemoScript = {
  lines: ["nobody:b is:m coming:b to:m save:b you", "so:m build:h@560", "done:b beats:b perfect:b every:m time", "post:h@520", "just:m ship:b it:m today:h@560"],
  options: { rate: 250, cueGap: 150, tail: 780 },
};

const INK = "#0A0A0C";
const GLYPHS = "ABCDEFGHKMNOPRSTUVWXZ0123456789#%&*/<>=+?";

export const pixelProgram = galleryScene("pixel", 1290, (ctx) => {
  const { cue, index } = ctx.window;
  const c = ctx.input.colours;
  const { cells, unit: u } = ctx.layout({
    column: 810, padding: 66, gap: 38, groups: roleRows(cue, 9),
    words: cue.words.map((word) => ({ text: word.role === "hero" ? caps(word, cue) : word.text, size: word.role === "hero" ? 128 : 62,
      face: word.role === "hero" ? "Silkscreen Bold" : "Space Mono Bold", spacing: 0 })),
  });
  const pieces: Piece[] = [];
  const hasHero = cue.words.some((word) => word.role === "hero");
  const rows = rowsOf(cells).map((row) => {
    const b = rowBounds(row);
    const hero = cue.words[row[0]!.at]!.role === "hero";
    const cx = (b.x1 + b.x2) / 2;
    const inkMid = (b.y1 + b.y2) / 2;
    const inkX = (b.x2 - b.x1) / 2;
    const inkY = Math.max((b.y2 - b.y1) / 2, ...row.map((cell) => cell.size * 0.5));
    const w = inkX + (hero ? 48 : 32) * u;
    const h = Math.max((hero ? 90 : 46) * u, inkY + 12 * u);
    const tilt = hero ? (index % 2 ? 3.6 : -3.6) * ctx.side : 0;
    const [cos, sin] = rotatePoint(1, 0, tilt);
    const [sparkX, sparkY] = rotatePoint((w - 6 * u) * ctx.side, -h + 6 * u, tilt);
    const [bracketX, bracketY] = rotatePoint((w + 10 * u) * ctx.side, h + 12 * u, tilt);
    return { row, hero, cx, inkMid, w, h, tilt, cos, sin, sparkX, sparkY, bracketX, bracketY,
      plateReach: w * Math.abs(sin) + h * cos,
      inkReach: inkX * Math.abs(sin) + inkY * cos,
      inkWidth: inkX * cos + inkY * Math.abs(sin) + (hero ? 0 : 26 * u),
    };
  });
  const centres: number[] = [];
  for (const [i, row] of rows.entries()) {
    const previous = rows[i - 1];
    if (!previous) {
      centres.push(row.h);
      continue;
    }
    // Start from the compact sample pitch, then clear the lettering and corner marks.
    const gap = previous.hero ? -14 : row.hero ? -2 : 12;
    let pitch = Math.max(previous.h + row.h + gap * u,
      previous.inkReach + row.plateReach + 4 * u,
      previous.plateReach + row.inkReach + 4 * u);
    if (row.hero && previous.hero) {
      pitch = Math.max(pitch, (previous.h + row.h + 3 * u + (row.cx - previous.cx) * row.sin) / row.cos);
    }
    if (row.hero && Math.abs(row.cx + row.sparkX - previous.cx) < previous.inkWidth + 42 * u) {
      pitch = Math.max(pitch, previous.inkReach - row.sparkY + 42 * u);
    }
    if (previous.hero && Math.abs(previous.cx + previous.bracketX - row.cx) < row.inkWidth + 34 * u) {
      pitch = Math.max(pitch, previous.bracketY + row.inkReach + 12 * u);
    }
    centres.push(centres[i - 1]! + pitch);
  }
  const height = centres.at(-1)! + rows.at(-1)!.h;
  const top = ctx.space.y(1290) - height / 2;
  for (const [i, { row, hero, cx, inkMid, w, h, tilt, cos, sin }] of rows.entries()) {
    const cy = top + centres[i]!;
    const first = cue.words[Math.min(...row.map((cell) => cell.at))]!;
    const { from, motion, settled } = ctx.enter(first, 175);
    const resize: Frames = motion ? [[from, 0.64], [settled, 1, "outExpo"]] : [[from, 1]];
    const local = (x: number, y: number) => ({
      x: resize.map(([at, scale, ease]) => [at, cx + x * scale * cos - y * sin, ease] as const),
      y: resize.map(([at, scale, ease]) => [at, cy + x * scale * sin + y * cos, ease] as const),
      rz: [[from, tilt]] as const,
    });
    const plate = ctx.shape(`label${i}`, from, polygonPath([
      [-w, -h + 6 * u], [-w + 16 * u, -h], [-w * 0.3, -h + 3 * u], [w - 8 * u, -h], [w, -h + 18 * u],
      [w - 4 * u, h - 8 * u], [w - 18 * u, h], [w * 0.45, h - 4 * u], [-w + 5 * u, h], [-w + 1 * u, h - 17 * u],
    ]), {
      x: [[from, cx]], y: [[from, cy]], rz: [[from, tilt]],
      sx: resize,
    }, hero ? c.highlight : INK);
    plate.shadows = [{ dx: 0, dy: 5 * u, blur: 6 * u, alpha: 0.45, colour: c.shadow }];
    pieces.push(plate);
    for (const cell of row) {
      const word = cue.words[cell.at]!;
      const entry = ctx.enter(word, hero ? 235 : 175);
      const pose = { ...local(cell.x - cx, inkCentre(cell) - inkMid), sx: resize };
      const face = ctx.face(cell, entry.from, hero ? INK : c.primary, pose);
      face.origin = { dx: 0, dy: inkCentre(cell) - cell.baseline };
      const swaps: Piece[] = [];
      if (/^[a-z]{2,18}$/i.test(cell.text)) {
        for (let tick = 0; tick < 3; tick++) {
          const at = entry.from + tick * 52;
          const end = Math.min(at + 52, entry.settled, word.startMs);
          if (paintedFrameCount(at, end, ctx.fps) < 2) break;
          const text = [...cell.text].map((char, slot) => {
            if (slot < Math.floor(cell.text.length * tick / 3)) return char;
            const glyph = GLYPHS[(index * 11 + cell.at * 7 + slot * 13 + tick * 19) % GLYPHS.length]!;
            return hero ? glyph : glyph.toLowerCase();
          }).join("");
          const ink = ctx.input.measure(text, cell.face, cell.size, cell.spacing);
          const sx = resize.map(([time, scale, ease]) => [time, scale * cell.width / Math.max(1, ink.advance), ease] as const);
          swaps.push({ ...face, id: `${face.id}swap${tick}`, text, z: 7, fromMs: at, toMs: end,
            origin: { dx: 0, dy: (ink.inkTop + ink.inkBottom) / 2 }, track: { ...pose, sx } });
        }
      }
      if (swaps.length) {
        const end = swaps.at(-1)!.toMs;
        face.track.o = [[entry.from, 0.02], [end - 1, 0.02], [end, 1], ...(ctx.exit ? [[ctx.exitAt, 1], [ctx.window.to, 0, "in"]] as const : [])];
      }
      pieces.push(...swaps, face);
      if (!hero) {
        const x = cell.x - cx + (cell.width / 2 + 14 * u) * ctx.side;
        const next = cue.words[cell.at + 1];
        const cursorEnd = next ? ctx.enter(next, 175).from : ctx.window.to;
        pieces.push({ ...ctx.rect(`cursor${cell.at}`, entry.from, cx, cy, 22 * u, 51 * u, 0, c.highlight,
          { ...local(x, 0), sx: resize }), toMs: cursorEnd, z: 8 });
      }
    }
    if (hero) {
      pieces.push({ ...ctx.shape(`spark${i}`, from, sparklePath(33 * u), local((w - 6 * u) * ctx.side, -h + 6 * u), c.primary),
        z: 8, stroke: { colour: INK, widthPx: 3 * u } });
      pieces.push({ ...ctx.shape(`bracket${i}`, from, polylinePath([[0, -25 * u], [0, 0], [-32 * u * ctx.side, 0]]),
        local((w + 10 * u) * ctx.side, h + 12 * u)),
      z: 5, stroke: { colour: c.accent, widthPx: 7 * u } });
    } else if (i === 0 && !hasHero) {
      pieces.push({ ...ctx.rect("tab", from, cx - (w + 2 * u) * ctx.side, cy - h + 4 * u, 28 * u, 28 * u, 0, c.highlight), z: 4 });
    }
  }
  if (ctx.exit) {
    const middle = top + height / 2;
    const clip = {
      x1: [[ctx.window.from, 0]] as const,
      x2: [[ctx.window.from, ctx.input.canvas.width]] as const,
      y1: [[ctx.window.from, 0], [ctx.exitAt, top - 64 * u], [ctx.window.to, middle, "in"]] as const,
      y2: [[ctx.window.from, ctx.input.canvas.height], [ctx.exitAt, top + height + 64 * u], [ctx.window.to, middle, "in"]] as const,
    };
    for (const piece of pieces) piece.clip = clip;
  }
  return pieces;
});
