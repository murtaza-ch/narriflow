import type { CaptionFontName } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { paintedFrameCount } from "../frame-grid";
import type { Piece } from "../scene";
import { galleryScene, inkCentre } from "./gallery-layout";

export const MATCH_DEMO: DemoScript = {
  lines: ["nobody:b warns:b you:m about:m the:m dip:h@520", "everyone:b quits:b right:m here:b", "the:m ones:b who:m stay:b win:h@560", "so:m keep:b going:b", "day:b ninety:h@620 is:m where:b it:m clicks:b"],
  options: { rate: 235, cueGap: 140, tail: 520, lead: 400 },
};

const CUTS: readonly { face: CaptionFontName; scale: number; spacing: number }[] = [
  { face: "Playfair Display Bold", scale: 0.95, spacing: 0 },
  { face: "Courier Prime", scale: 0.9, spacing: -0.02 },
  { face: "Playfair Display Bold Italic", scale: 0.95, spacing: 0 },
  { face: "Space Grotesk Bold", scale: 0.96, spacing: -0.01 },
];

export const matchProgram = galleryScene("match", 1290, (ctx) => {
  const { cue, index, to } = ctx.window;
  const { colours, measure } = ctx.input;
  const { cells, unit: u } = ctx.layout({
    column: 900, padding: 52, gap: 22,
    groups: Array.from({ length: Math.ceil(cue.words.length / 3) }, (_, i) => [i * 3, i * 3 + 1, i * 3 + 2].filter((at) => at < cue.words.length)),
    words: cue.words.map((word) => ({ text: word.text, face: word.role === "hero" ? "Inter Tight ExtraBold" : "Inter Tight Bold",
      size: word.role === "hero" ? 114 : 100, spacing: -0.015 })),
  });
  const pieces: Piece[] = [];
  for (const cell of cells) {
    const word = cue.words[cell.at]!;
    const hero = word.role === "hero";
    const { from, settled } = ctx.enter(word, 410);
    const base = ctx.face(cell, from, hero ? colours.accent : colours.primary);
    if (hero) {
      const centre = inkCentre(cell);
      const jog = [-2.4, 1.6, -1.1, 0.6];
      const cuts = jog.flatMap((angle, i) => {
        const at = from + i * 100;
        return at < settled ? [[at, angle], [Math.min(at + 99, settled - 1), angle]] as const : [];
      });
      const rotation = cuts.length ? [...cuts, [settled, -0.8] as const] : [[from, -0.8] as const];
      pieces.push(ctx.rect(`box${cell.at}`, from, cell.x, centre, cell.width + 38 * u, cell.size * 1.12, 0, colours.highlight, { rz: rotation }));
      base.track = { ...base.track, y: [[from, centre]], rz: rotation };
      base.origin = { dx: 0, dy: centre - cell.baseline };
    } else {
      const ends = Math.min(settled, from + 400);
      const snapshots: Piece[] = [];
      for (let i = 0; i < 4; i++) {
        const start = from + i * 100;
        const end = Math.min(start + 100, ends);
        if (paintedFrameCount(start, end, ctx.fps) < 2) break;
        const cut = CUTS[(i + index * 3) % CUTS.length]!;
        const sizePx = cell.size * cut.scale;
        const metric = measure(cell.text, cut.face, sizePx, cut.spacing);
        snapshots.push({ ...base, id: `${base.id}cut${i}`, z: 7, fromMs: start, toMs: end,
          face: cut.face, sizePx, letterSpacingEm: cut.spacing, track: { x: [[start, cell.x]], y: [[start, inkCentre(cell) - (metric.inkTop + metric.inkBottom) / 2]],
            sx: [[start, cell.width / Math.max(1, metric.advance)]] } });
      }
      if (snapshots.length) {
        const after = snapshots.at(-1)!.toMs;
        base.track.o = [[from, 0.02], [after - 1, 0.02], [after, 1], ...(ctx.exit ? [[ctx.exitAt, 1], [to, 0, "in"]] as const : [])];
      }
      pieces.push(...snapshots);
      base.shadows = [{ dx: 0, dy: 6 * u, blur: 8 * u, colour: ctx.input.colours.shadow, alpha: 0.72 }];
    }
    pieces.push(base);
  }
  return pieces;
});
