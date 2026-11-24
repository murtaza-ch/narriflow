import type { DemoScript } from "../demo";
import type { Box, PathCmd, Piece } from "../scene";
import { ellipsePath, polygonPath, roundedRectPath } from "../shapes";
import { caps, galleryScene, inkCentre } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

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

function iconLayers(index: number, lime: string): readonly IconLayer[] {
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

const ROW_SHIFT = [-36, 28, -18];
/** The icon pops to 1.24 of its 100 grid: the box it needs beside its label, plus the clear space kept between them. */
const ICON_BOX = 124;
const ICON_REACH = 68;
const ICON_GAP = 12;
const ROW_GAP = 4;
const LABEL_GAP = 10;

interface Tag {
  readonly cell: SpeechCell;
  readonly hero: boolean;
  readonly small: boolean;
  readonly w: number;
  readonly h: number;
  readonly tilt: number;
  /** Half the box of the tilted label. */
  readonly halfW: number;
  readonly halfH: number;
}

interface Item {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

interface Placed {
  readonly x: number;
  readonly dy: number;
}

/**
 * The layout reserves one text height per row, but labels are taller and tilt swings their ends, so rows are pushed
 * apart until no label touches the one above. A hero's icon takes room in the row beside the label, on the side
 * away from the row's other word (never over a neighbour); one icon per row, the first hero's.
 */
function arrange(tags: readonly Tag[], u: number, side: number, seed: number, safe: Box) {
  const rows = new Map<number, Tag[]>();
  for (const tag of tags) rows.set(tag.cell.baseline, [...(rows.get(tag.cell.baseline) ?? []), tag]);
  const placed = new Map<number, Placed>();
  const icons = new Map<number, { dir: number; x: number }>();
  const done: Item[] = [];
  const before: Item[] = [];
  let iconRows = 0;
  [...rows.values()].forEach((row, r) => {
    const ordered = [...row].sort((a, b) => a.cell.x - b.cell.x);
    const lead = ordered.find((tag) => tag.hero);
    let dir = 0;
    if (lead) {
      const at = ordered.indexOf(lead);
      const open = [at === 0 ? -1 : 0, at === ordered.length - 1 ? 1 : 0].filter((d) => d !== 0);
      dir = open.length === 2 ? side * (iconRows++ % 2 ? -1 : 1) : open[0]!;
    }
    const iconAt = (x: number) => x + dir * (lead!.halfW + (ICON_GAP + ICON_BOX / 2) * u);
    // Labels are wider than their text: lay the row out again by label width, a small gap apart, on the same centre.
    const spaced = new Map<number, number>();
    let edge = 0;
    for (const tag of ordered) {
      spaced.set(tag.cell.at, edge + tag.halfW);
      edge += 2 * tag.halfW + LABEL_GAP * u;
    }
    const centre = (Math.min(...ordered.map((tag) => tag.cell.x - tag.halfW)) + Math.max(...ordered.map((tag) => tag.cell.x + tag.halfW))) / 2;
    const recentred = centre - (edge - LABEL_GAP * u) / 2;
    const posX = (tag: Tag) => spaced.get(tag.cell.at)! + recentred;
    const lo = posX(ordered[0]!) - ordered[0]!.halfW;
    const hi = posX(ordered.at(-1)!) + ordered.at(-1)!.halfW;
    let left = lo;
    let right = hi;
    if (lead) {
      left = Math.min(left, iconAt(posX(lead)) - ICON_REACH * u);
      right = Math.max(right, iconAt(posX(lead)) + ICON_REACH * u);
    }
    // Words and icon are centred on the column together, staggered row by row as in the sample.
    let dx = (lo + hi) / 2 - (left + right) / 2 + ROW_SHIFT[(r + seed) % 3]! * u * side;
    dx = Math.min(Math.max(dx, safe.x1 + 4 - left), safe.x2 - 4 - right);
    const items = ordered.map((tag): Item => {
      const cy = inkCentre(tag.cell);
      return { x1: posX(tag) + dx - tag.halfW, x2: posX(tag) + dx + tag.halfW, y1: cy - tag.halfH, y2: cy + tag.halfH + 6 * u };
    });
    if (lead) {
      const cy = inkCentre(lead.cell);
      const x = iconAt(posX(lead) + dx);
      items.push({ x1: x - ICON_REACH * u, x2: x + ICON_REACH * u, y1: cy - ICON_REACH * u, y2: cy + ICON_REACH * u });
      icons.set(lead.cell.at, { dir, x });
    }
    let drop = 0;
    for (const item of items) {
      for (const above of done) {
        if (item.x1 < above.x2 && item.x2 > above.x1) drop = Math.max(drop, above.y2 + ROW_GAP * u - item.y1);
      }
    }
    for (const item of items) {
      before.push({ ...item });
      done.push({ ...item, y1: item.y1 + drop, y2: item.y2 + drop });
    }
    for (const tag of ordered) placed.set(tag.cell.at, { x: posX(tag) + dx, dy: drop });
  });
  // Keep the block centred where the layout put it.
  const mid = (items: readonly Item[]) => (Math.min(...items.map((item) => item.y1)) + Math.max(...items.map((item) => item.y2))) / 2;
  const recentre = mid(before) - mid(done);
  for (const [at, place] of placed) placed.set(at, { x: place.x, dy: place.dy + recentre });
  return { placed, icons, recentre };
}

export const stickyProgram = galleryScene("sticky", 1290, (ctx) => {
  const { cue, index } = ctx.window;
  const c = ctx.input.colours;
  // Two words to a row, but two key words never share one: their big labels would run into each other.
  const groups: number[][] = [];
  for (const [at, word] of cue.words.entries()) {
    const last = groups.at(-1);
    if (last && last.length < 2 && !(word.role === "hero" && cue.words[at - 1]!.role === "hero")) last.push(at);
    else groups.push([at]);
  }
  const { cells, unit: u } = ctx.layout({
    column: 800, padding: 70, gap: 74,
    words: cue.words.map((word) => ({ text: caps(word, cue), size: word.role === "hero" ? 104 : word.role === "minor" ? 48 : 60, face: "Space Mono Bold", spacing: 0.02 })),
    groups,
  });
  const tags = cells.map((cell): Tag => {
    const hero = cue.words[cell.at]!.role === "hero";
    const small = cue.words[cell.at]!.role === "minor";
    const w = cell.width + (hero ? 68 : small ? 36 : 48) * u;
    const h = Math.max(cell.size + (hero ? 28 : small ? 16 : 24) * u, (cell.inkBottom - cell.inkTop) + 16 * u);
    const tilt = (hero ? (index % 2 ? 5 : -5) : [-5, 4, -3, 6, -6, 3, -4, 5][(cell.at + index) % 8]!) * ctx.side;
    const radians = Math.abs(tilt) * Math.PI / 180;
    return {
      cell, hero, small, w, h, tilt,
      halfW: (w / 2) * Math.cos(radians) + (h / 2) * Math.sin(radians),
      halfH: (w / 2) * Math.sin(radians) + (h / 2) * Math.cos(radians),
    };
  });
  const { placed, icons } = arrange(tags, u, ctx.side, index, ctx.window.bounds);
  const pieces: Piece[] = [];
  let heroes = ctx.input.cues.slice(0, index).reduce((sum, prior) => sum + prior.words.filter((word) => word.role === "hero").length, 0);
  for (const tag of tags) {
    const { hero, small, w, h, tilt } = tag;
    const place = placed.get(tag.cell.at)!;
    const cell: SpeechCell = { ...tag.cell, x: place.x, baseline: tag.cell.baseline + place.dy };
    const word = cue.words[cell.at]!;
    const g = cell.at + index;
    const cy = inkCentre(cell);
    const { from, settled, motion } = ctx.enter(word, 245);
    const fill = hero ? (heroes % 3 === 1 ? RED : c.highlight) : small ? "#2B2E3B" : FILLS[g % FILLS.length]!;
    const sx = motion ? [[from, 0.29], [settled, 1, "outBack"]] as const : [[from, 1]] as const;
    const track = { x: [[from, cell.x]] as const, y: ctx.drift(from, cy, motion ? 14 * u : 0, settled, 20 * u), sx, sy: sx, rz: [[from, tilt]] as const };
    const edge = (g % 3 === 0 && !small) ? polygonPath([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2 - 13 * u, 0], [w / 2, h / 2], [-w / 2, h / 2]]) : roundedRectPath(-w / 2, -h / 2, w, h, 8 * u);
    pieces.push({ ...ctx.shape(`tag${cell.at}`, from, edge, track, fill), z: 5,
      shadows: [{ dx: 0, dy: 6 * u, blur: 4 * u, alpha: 0.34, colour: c.shadow }] });
    const text = ctx.face(cell, from, fill === c.highlight ? INK : c.primary, track);
    text.origin = { dx: 0, dy: cy - cell.baseline };
    pieces.push(text);
    if (!hero) continue;
    const kind = heroes++;
    const icon = icons.get(cell.at);
    if (!icon) continue;
    const enterAt = Math.min(word.endMs, word.startMs + 150);
    const scale = [[enterAt, 0.2 * u], [Math.min(enterAt + 180, ctx.window.to - 1), 1.24 * u, "outBack"]] as const;
    for (const [j, [path, colour]] of iconLayers(kind, c.highlight).entries()) {
      pieces.push({ ...ctx.shape(`icon${cell.at}-${j}`, enterAt, path, { x: [[enterAt, icon.x]], y: [[enterAt, cy]], sx: scale, sy: scale, rz: [[enterAt, 11 * icon.dir]] }, colour),
        origin: { dx: 50, dy: 50 }, z: j + 8, shadows: [{ dx: 0, dy: 6 * u, blur: 2 * u, alpha: 0.34, colour: c.shadow }] });
    }
  }
  return pieces;
});
