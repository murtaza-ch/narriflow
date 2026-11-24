import type { DemoScript } from "../demo";
import { balancedRows, rowVisualOrder } from "../layout";
import type { Piece } from "../scene";
import { caps, galleryScene, inkCentre, rectClip, roleRows } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

export const MDRN_DEMO: DemoScript = {
  lines: ["great taste feels:m simple:h@600", "less is:m more", "people remember how:m it:m felt:h@560", "make it:m yours:h@560", "start today:h@600"],
  options: { rate: 235, gap: 30, cueGap: 170, tail: 620, lead: 350 },
};

// Design-space numbers (1080 wide). Rows hang from the leading edge; the asterisk and the dash each get a slot of their
// own at the trailing end of a row, so neither can land on a letter or on the other.
const COLUMN = 800;
const WORD_GAP = 31;
const ROW_GAP = 24;
const STAGGER = 70;
const MIN_SQUEEZE = 0.8;
const PILL_PAD = 27.5;
const PILL_HEIGHT = 86;
const STAR_GAP = 8;
const DASH_GAP = 28;
const DASH_WIDTH = 83;
const STAR_FACE = "Archivo Expanded Black" as const;

interface Item {
  readonly at: number;
  readonly text: string;
  readonly face: SpeechCell["face"];
  readonly size: number;
  readonly spacing: number;
  readonly pill: boolean;
  readonly hero: boolean;
}

export const mdrnProgram = galleryScene("mdrn", 1290, (ctx) => {
  const { cue } = ctx.window;
  const { measure, colours: c } = ctx.input;
  const u = ctx.space.u;
  const dir = ctx.rtl ? "rtl" : "ltr";
  const pillAt = cue.words.findIndex((word) => word.role === "minor");
  const items: Item[] = cue.words.map((word, at) => ({
    at, text: caps(word, cue), pill: at === pillAt, hero: word.role === "hero",
    size: at === pillAt ? 53.6 : word.role === "hero" ? 171.5 : word.role === "minor" ? 67 : 134,
    face: at === pillAt ? "Archivo Expanded ExtraBold" : "Archivo Expanded Black",
    spacing: at === pillAt ? 0.06 : -0.012,
  }));
  // Rows: the pill leads the words that follow it. The hero always closes its row, so the asterisk has free space after it.
  const groups = (pillAt > 0
    ? [...Array.from({ length: Math.ceil(pillAt / 2) }, (_, i) => [i * 2, i * 2 + 1].filter((at) => at < pillAt)), cue.words.map((_, at) => at).slice(pillAt)]
    : roleRows(cue, 2)
  ).flatMap((group) => {
    const heroAt = group.findIndex((at) => items[at]!.hero);
    return heroAt < 0 || heroAt === group.length - 1 ? [group] : [group.slice(0, heroAt + 1), group.slice(heroAt + 1)];
  });

  // Measure once at the design size; every length below scales with the fit.
  const star = measure("*", STAR_FACE, 100, 0);
  const starAdvance = star.advance / 100;
  const starSize = (item: Item) => item.size * 0.9;
  const advance = items.map((item) => measure(item.text, item.face, item.size * u, item.spacing));
  const padOf = (item: Item) => item.pill ? PILL_PAD * u : 0;
  const slotOf = (item: Item) => item.hero ? (STAR_GAP + starSize(item) * starAdvance) * u : 0;
  const widthOf = (at: number) => advance[at]!.advance + 2 * padOf(items[at]!) + slotOf(items[at]!);
  const rowWidth = (row: readonly number[]) => row.reduce((sum, at) => sum + widthOf(at), WORD_GAP * u * (row.length - 1));
  const dashSlot = (DASH_GAP + DASH_WIDTH) * u;
  const { bounds } = ctx.window;
  const room = Math.min(COLUMN * u, ctx.rtl ? ctx.space.x(990) - bounds.x1 - 3 : bounds.x2 - 3 - ctx.space.x(90));
  const wrap = (limit: number) => groups.flatMap((group) => balancedRows(group.map(widthOf), WORD_GAP * u, limit).map((row) => row.map((at) => group[at]!)));
  let rows = wrap(room);
  const heroFirst = (row: readonly number[]) => row.some((at) => items[at]!.hero);
  // The first row ends in the dash unless its hero already ends it in the asterisk.
  const dashed = rows.length > 0 && !heroFirst(rows[0]!);
  // A row a little too wide for its dash shrinks the cue a touch; a clearly too wide one wraps instead.
  if (dashed && room / (rowWidth(rows[0]!) + dashSlot) < MIN_SQUEEZE) rows = wrap(room - dashSlot);
  const trailing = (i: number) => (i === 0 && dashed ? dashSlot : 0);

  const extent = (row: readonly number[]) => {
    let above = 0;
    let below = 0;
    for (const at of row) {
      const { inkTop, inkBottom } = advance[at]!;
      above = Math.max(above, -inkTop);
      below = Math.max(below, inkBottom);
      if (items[at]!.pill) {
        const half = PILL_HEIGHT * u / 2;
        const mid = (inkTop + inkBottom) / 2;
        above = Math.max(above, half - mid);
        below = Math.max(below, half + mid);
      }
    }
    return { above, below };
  };
  const heightAt1 = rows.reduce((sum, row) => sum + extent(row).above + extent(row).below, ROW_GAP * u * (rows.length - 1));
  const fit = Math.min(1, ...rows.map((row, i) => room / (rowWidth(row) + trailing(i))), (bounds.y2 - bounds.y1 - 6) / heightAt1);

  const k = u * fit;
  const edge = ctx.space.x(ctx.rtl ? 990 : 90);
  const sized = items.map((item) => ({ ...item, size: item.size * fit }));
  const metrics = items.map((item, at) => measure(item.text, item.face, sized[at]!.size * u, item.spacing));
  const stars = { advance: starAdvance, inkTop: star.inkTop / 100 };
  const gaps = WORD_GAP * k;
  const total = rows.reduce((sum, row) => {
    const e = extent(row);
    return sum + (e.above + e.below) * fit;
  }, ROW_GAP * k * (rows.length - 1));
  let y = Math.min(bounds.y2 - 3 - total, Math.max(bounds.y1 + 3, ctx.space.y(1290) - total / 2));
  const pieces: Piece[] = [];
  for (const [i, row] of rows.entries()) {
    const e = extent(row);
    const baseline = y + e.above * fit;
    y += (e.above + e.below) * fit + ROW_GAP * k;
    const order = rowVisualOrder(row.map((at) => items[at]!.text), dir).map((j) => row[j]!);
    // Widths at the final size.
    const w = (at: number) => widthOf(at) * fit;
    const span = order.reduce((sum, at) => sum + w(at), gaps * (order.length - 1));
    const stagger = i > 0 && span + STAGGER * k <= room ? STAGGER * k : 0;
    // `left` is the visual left of the words; the dash slot trails the row, so it sits left of the words in RTL.
    const left = ctx.rtl ? edge - stagger - span : edge + stagger;
    let x = left;
    const cells = new Map<number, SpeechCell>();
    for (const at of order) {
      const item = items[at]!;
      const adv = metrics[at]!.advance;
      const pad = padOf(item) * fit;
      const slotHere = slotOf(item) * fit;
      const startX = x + (ctx.rtl ? slotHere : 0);
      cells.set(at, {
        at, text: item.text, face: item.face, spacing: item.spacing, size: sized[at]!.size * u,
        x: startX + pad + adv / 2, baseline, width: adv, inkTop: metrics[at]!.inkTop, inkBottom: metrics[at]!.inkBottom,
      });
      x += w(at) + gaps;
    }
    for (const at of order) {
      const cell = cells.get(at)!;
      const word = cue.words[at]!;
      const { from, settled, motion } = ctx.enter(word, 260);
      const travel = motion ? Math.min(cell.size * 0.49, (cell.inkBottom - cell.inkTop) * 0.8) : 0;
      const shown = ctx.face(cell, from, c.primary, { y: ctx.drift(from, cell.baseline, travel, settled, -40 * u) });
      if (items[at]!.pill) {
        const cy = inkCentre(cell);
        pieces.push({ ...ctx.rect("pill", from, cell.x, cy, cell.width + 2 * PILL_PAD * k, PILL_HEIGHT * k, 40 * k, c.primary, { y: ctx.drift(from, cy, travel, settled, -40 * u) }),
          fill: undefined, stroke: { colour: c.primary, widthPx: 2 * u } });
      } else {
        shown.clip = rectClip(from, { x1: cell.x - cell.width / 2 - 12 * u, x2: cell.x + cell.width / 2 + 12 * u,
          y1: cell.baseline + cell.inkTop - 44 * u, y2: cell.baseline + cell.inkBottom + 2 * u });
        shown.shadows = [{ dx: 0, dy: 4 * u, blur: 7 * u, alpha: 0.5, colour: c.shadow }];
      }
      pieces.push(shown);
      if (items[at]!.hero) {
        // The asterisk sits in the slot after the hero, level with the top of its capitals, and drops in from a mask edge.
        const size = starSize(sized[at]!) * u;
        const gapPx = STAR_GAP * k;
        const cx = cell.x + (cell.width / 2 + gapPx + (size * stars.advance) / 2) * ctx.side;
        const rest = cell.baseline + cell.inkTop - size * stars.inkTop;
        const hold = { x1: cx - size * stars.advance / 2 - 2 * u, x2: cx + size * stars.advance / 2 + 2 * u, y1: cell.baseline + cell.inkTop - 3 * u, y2: cell.baseline + cell.inkBottom };
        pieces.push({ ...ctx.face(cell, from, c.highlight, { x: [[from, cx]], y: ctx.drift(from, rest, motion ? -58 * u : 0, settled, -40 * u) }),
          id: `${ctx.id}:asterisk${cell.at}`, z: 8, text: "*", face: STAR_FACE, sizePx: size, letterSpacingEm: 0,
          clip: rectClip(from, hold) });
      }
    }
    if (i === 0 && dashed) {
      const last = cells.get(ctx.rtl ? order[0]! : order.at(-1)!)!;
      const reach = last.width / 2 + (items[last.at]!.pill ? PILL_PAD * k : 0);
      const edgeX = ctx.rtl ? last.x - reach : last.x + reach;
      const word = cue.words[Math.max(...row)]!;
      const { from, settled, motion } = ctx.enter(word, 230, 20);
      const mid = baseline + (Math.min(...order.map((at) => cells.get(at)!.inkTop)) + Math.max(...order.map((at) => cells.get(at)!.inkBottom))) / 2;
      pieces.push(ctx.rect("dash", from, edgeX + (DASH_GAP * k + DASH_WIDTH * k / 2) * ctx.side, mid, DASH_WIDTH * k, 13 * k, 0, c.highlight,
        motion ? { sx: [[from, 0.1], [settled, 1, "outExpo"]] } : {}));
    }
  }
  return pieces;
});
