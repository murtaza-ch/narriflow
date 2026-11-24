import type { DemoScript } from "../demo";
import type { PathCmd, Piece } from "../scene";
import { ellipsePath, polygonPath, roundedRectPath } from "../shapes";
import { caps, galleryScene, inkCentre } from "./gallery-layout";

export const STICKY_DEMO: DemoScript = {
  lines: ["stop:b scrolling:b and:m watch:h", "this:m edit:b is:m pure:b fire:h", "just:m ten:b seconds:b", "faster:h than:m ever:b", "you:m will love:h it:m", "click:h the:m link:b"],
  options: { rate: 215, gap: 35, cueGap: 170, tail: 600, lead: 300 },
};

const BLUE = "#5B6BB5";
const RED = "#E8343F";
const MAUVE = "#9A6B9E";
const INK = "#1B1D26";
const FILLS = [BLUE, "#8E8A64", MAUVE, RED];
type IconLayer = readonly [readonly PathCmd[], string];

function icon(index: number, lime: string): readonly IconLayer[] {
  const eye: PathCmd[] = [["M", 4, 50], ["C", 34, 21, 66, 21, 96, 50], ["C", 66, 79, 34, 79, 4, 50], ["Z"]];
  const flame: PathCmd[] = [["M", 52, 3], ["C", 58, 26, 86, 38, 86, 64], ["C", 86, 112, 14, 112, 14, 64],
    ["C", 14, 46, 28, 38, 34, 20], ["C", 40, 30, 46, 22, 52, 3], ["Z"]];
  const innerFlame: PathCmd[] = [["M", 50, 48], ["C", 54, 60, 68, 64, 68, 76], ["C", 68, 100, 32, 100, 32, 76], ["C", 32, 66, 44, 62, 50, 48], ["Z"]];
  const heart: PathCmd[] = [["M", 50, 76], ["C", 20, 56, 22, 30, 38, 28], ["C", 45, 27, 50, 31, 50, 38],
    ["C", 50, 31, 55, 27, 62, 28], ["C", 78, 30, 80, 56, 50, 76], ["Z"]];
  switch (index % 5) {
    case 0: return [[eye, BLUE], [ellipsePath(50, 50, 23), INK], [ellipsePath(58, 42, 8), "#FFFFFF"]];
    case 1: return [[flame, RED], [innerFlame, lime]];
    case 2: return [[polygonPath([[60, 2], [14, 56], [44, 56], [36, 98], [86, 40], [56, 40]]), lime]];
    case 3: return [[ellipsePath(50, 50, 47), RED], [heart, "#FFFFFF"]];
    default: return [[polygonPath([[18, 6], [18, 80], [37, 63], [49, 92], [64, 86], [52, 58], [78, 58]]), MAUVE]];
  }
}

export const stickyProgram = galleryScene("sticky", 1290, (ctx) => {
  const { cue, index } = ctx.window;
  const c = ctx.input.colours;
  const { cells, unit: u } = ctx.layout({
    column: 760, padding: 90, gap: 58,
    words: cue.words.map((word) => ({ text: caps(word, cue), size: word.role === "hero" ? 104 : word.role === "minor" ? 40 : 60, face: "Space Mono Bold", spacing: 0.02 })),
    groups: Array.from({ length: Math.ceil(cue.words.length / 2) }, (_, i) => [i * 2, i * 2 + 1].filter((at) => at < cue.words.length)),
  });
  const pieces: Piece[] = [];
  let heroes = ctx.input.cues.slice(0, index).reduce((sum, prior) => sum + prior.words.filter((word) => word.role === "hero").length, 0);
  for (const cell of cells) {
    const word = cue.words[cell.at]!;
    const hero = word.role === "hero";
    const small = word.role === "minor";
    const g = cell.at + index;
    const cy = inkCentre(cell);
    const { from, settled, motion } = ctx.enter(word, 245);
    const fill = hero ? (heroes % 3 === 1 ? RED : c.highlight) : small ? "#2B2E3B" : FILLS[g % FILLS.length]!;
    const w = cell.width + (hero ? 68 : small ? 36 : 48) * u;
    const h = Math.max(cell.size + (hero ? 28 : small ? 16 : 24) * u, (cell.inkBottom - cell.inkTop) + 16 * u);
    const tilt = (hero ? (index % 2 ? 5 : -5) : [-5, 4, -3, 6, -6, 3, -4, 5][g % 8]!) * ctx.side;
    const sx = motion ? [[from, 0.29], [settled, 1, "outBack"]] as const : [[from, 1]] as const;
    const track = { x: [[from, cell.x]] as const, y: ctx.drift(from, cy, motion ? 14 * u : 0, settled, 20 * u), sx, sy: sx, rz: [[from, tilt]] as const };
    const edge = (g % 3 === 0 && !small) ? polygonPath([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2 - 13 * u, 0], [w / 2, h / 2], [-w / 2, h / 2]]) : roundedRectPath(-w / 2, -h / 2, w, h, 8 * u);
    pieces.push({ ...ctx.shape(`tag${cell.at}`, from, edge, track, fill), z: 5,
      shadows: [{ dx: 0, dy: 6 * u, blur: 4 * u, alpha: 0.34, colour: c.shadow }] });
    const text = ctx.face(cell, from, fill === c.highlight ? INK : c.primary, track);
    text.origin = { dx: 0, dy: cy - cell.baseline };
    pieces.push(text);
    if (!hero) continue;
    const side = (heroes % 2 ? -1 : 1) * ctx.side;
    const x = cell.x + (w / 2 + 64 * u) * side;
    const enterAt = Math.min(word.endMs, word.startMs + 150);
    const scale = [[enterAt, 0.2 * u], [Math.min(enterAt + 180, ctx.window.to - 1), 1.24 * u, "outBack"]] as const;
    for (const [j, [path, colour]] of icon(heroes++, c.highlight).entries()) {
      pieces.push({ ...ctx.shape(`icon${cell.at}-${j}`, enterAt, path, { x: [[enterAt, x]], y: [[enterAt, cy]], sx: scale, sy: scale, rz: [[enterAt, 11 * side]] }, colour),
        origin: { dx: 50, dy: 50 }, z: j + 8, shadows: [{ dx: 0, dy: 6 * u, blur: 2 * u, alpha: 0.34, colour: c.shadow }] });
    }
  }
  return pieces;
});
