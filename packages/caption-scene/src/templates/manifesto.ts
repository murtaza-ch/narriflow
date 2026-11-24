import type { DemoScript } from "../demo";
import { paintedFrameCount } from "../frame-grid";
import { rowVisualOrder } from "../layout";
import type { Piece } from "../scene";
import { caps, galleryScene, rectClip } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

export const MANIFESTO_DEMO: DemoScript = {
  lines: ["most:b people:b wait:b for:m permission:h@540", "nobody:b is:m coming:b to:m save:b you:h@440", "build:h@480 it:m now:b", "slow:b is:m smooth:b smooth:b is:m fast:b", "start:b before:b you:m feel:b ready:h@520"],
  options: { rate: 215, gap: 20, cueGap: 140, tail: 620, lead: 350 },
};

/** The sample's minimum word gap (em), block height budget and the least a row may fill before it is centred instead of justified. */
const WORD_GAP = 0.2;
const MAX_BLOCK = 660;
const JUSTIFY_FROM = 0.85;

export const manifestoProgram = galleryScene("manifesto", 1290, (ctx) => {
  const { cue } = ctx.window;
  const { measure, colours } = ctx.input;
  const face = "Anton";
  const u = ctx.space.u;
  const width = Math.min(840 * u, (ctx.space.safe.x2 - ctx.space.safe.x1) * 0.84);
  const rows: number[][] = [];
  for (let i = 0; i < cue.words.length; i += 2) {
    if (cue.words[i]?.role === "hero" && i + 1 < cue.words.length) {
      rows.push([i]);
      i--;
    } else rows.push(i + 1 < cue.words.length ? [i, i + 1] : [i]);
  }
  const rowSizes = rows.map((row) => {
    const words = row.map((at) => caps(cue.words[at]!, cue));
    const widthEm = words.reduce((sum, word) => sum + measure(word, face, 100, 0).advance / 100, 0);
    return Math.min(330 * u, width / (widthEm + WORD_GAP * (row.length - 1)));
  });
  // The block keeps the sample's height budget: every line shrinks together when the stack is too tall.
  const rawHeight = rowSizes.reduce((sum, size) => sum + size * 0.96, 14 * u * (rows.length - 1));
  const sizes = rowSizes.map((size) => size * Math.min(1, MAX_BLOCK * u / rawHeight));
  const gap = 14 * u;
  const height = sizes.reduce((sum, size) => sum + size * 0.96, gap * (rows.length - 1));
  let y = ctx.space.y(1290) - height / 2;
  const pieces: Piece[] = [];
  for (const [i, row] of rows.entries()) {
    const size = sizes[i]!;
    const centre = y + size * 0.48;
    y += size * 0.96 + gap;
    const texts = row.map((at) => caps(cue.words[at]!, cue));
    const natural = texts.reduce((sum, text) => sum + measure(text, face, size, 0).advance, size * WORD_GAP * (row.length - 1));
    // Only a row that nearly fills the column is justified; a short row keeps its natural gaps and is centred.
    // Letters are never tracked out.
    const spacing = 0;
    const metrics = texts.map((text) => measure(text, face, size, spacing));
    const wide = metrics.reduce((sum, metric) => sum + metric.advance, 0);
    const justified = row.length > 1 && natural / width >= JUSTIFY_FROM;
    const between = justified ? (width - wide) / (row.length - 1) : size * WORD_GAP;
    const rowWide = wide + between * (row.length - 1);
    const left = ctx.space.x(540) - rowWide / 2;
    const right = left + rowWide;
    let x = left;
    const hero = row.some((at) => cue.words[at]!.role === "hero");
    if (hero) {
      const { from, settled, motion } = ctx.enter(cue.words[row[0]!]!, 150);
      pieces.push(ctx.rect(`bar${i}`, from, ctx.space.x(540), centre, rowWide + 36 * u, size * 0.91, 0, colours.primary,
        motion ? { sx: [[from, 0.24], [settled, 1, "outExpo"]], sy: [[from, 0.15], [settled, 1, "outExpo"]] } : {}));
    }
    for (const j of rowVisualOrder(texts, ctx.rtl ? "rtl" : "ltr")) {
      const at = row[j]!;
      const metric = metrics[j]!;
      const cell: SpeechCell = { at, text: texts[j]!, face, spacing, size, width: metric.advance, x: x + metric.advance / 2,
        baseline: centre - (metric.inkTop + metric.inkBottom) / 2, inkTop: metric.inkTop, inkBottom: metric.inkBottom };
      x += metric.advance + between;
      const word = cue.words[at]!;
      const { from, settled } = ctx.enter(word, 85, 55);
      const snapAt = Math.min(settled, word.startMs);
      const sliceIn = paintedFrameCount(from, snapAt, ctx.fps) >= 2;
      const fill = hero ? colours.highlight : colours.primary;
      const base = ctx.face(cell, sliceIn ? snapAt : from, fill);
      // The four slices meet before the word is spoken.
      if (sliceIn) {
        const top = cell.baseline + metric.inkTop;
        const band = (metric.inkBottom - metric.inkTop) / 4;
        const shift = Math.min(10 * u, size * 0.04) * ctx.side;
        for (const [slice, direction] of [-1, 0.75, -0.6, 1].entries()) {
          pieces.push({ ...base, id: `${base.id}s${slice}`, fromMs: from, toMs: snapAt, z: 7,
            clip: rectClip(from, { x1: left - 24 * u, x2: right + 24 * u, y1: top + slice * band - u, y2: top + (slice + 1) * band + u }),
            track: { x: [[from, cell.x + shift * direction], [snapAt, cell.x, "outExpo"]], y: [[from, cell.baseline]] } });
        }
      }
      if (!hero) base.shadows = [{ dx: 0, dy: size * 0.05, blur: 3 * u, colour: colours.accent, alpha: 0.85 }];
      pieces.push(base);
    }
  }
  return pieces;
});
