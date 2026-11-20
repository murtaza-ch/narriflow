import type { SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { Piece } from "../scene";

/**
 * The placeholder program every template not ported yet draws: the cue's words in one centred row
 * (evenly wrapped when they do not fit), each fading in on its spoken start. It exists so the
 * catalogue, the picker and the thumbnails are complete; each template ticket replaces its own.
 */

const FACE = "Inter Tight Bold" as const;
const SIZE = 72;
const GAP_EM = 0.24;
const LINE_EM = 1.2;
const BASELINE_EM = 0.86;
const FADE_MS = 140;

export const placeholderProgram: SceneProgram = {
  build(input: SceneInput) {
    const space = sceneSpace(input, 1300);
    const pieces: Piece[] = [];
    for (const cue of input.cues) {
      // A word wider than a row shrinks the cue to fit; rows otherwise wrap evenly.
      const widest = Math.max(...cue.words.map((word) => input.measure(word.text, FACE, SIZE * space.u, 0).advance));
      const size = SIZE * space.u * fitScale(widest, 0.9 * space.canvas.width);
      const direction = cueDirection(cue);
      const boxes = cue.words.map((word) => {
        const m = input.measure(word.text, FACE, size, 0);
        return m.advance;
      });
      const gap = GAP_EM * size;
      const rows = balancedRows(boxes, gap, 0.9 * space.canvas.width);
      const blockHeight = rows.length * LINE_EM * size;
      let top = space.y(1300) - blockHeight / 2;
      const cuePieces: Piece[] = [];
      for (const row of rows) {
        const order = rowVisualOrder(row.map((at) => cue.words[at]!.text), direction).map((at) => row[at]!);
        let x = space.x(540) - rowWidth(boxes, order, gap) / 2;
        for (const at of order) {
          const word = cue.words[at]!;
          cuePieces.push({
            id: `placeholder:${cue.index}:${at}`,
            kind: "text",
            z: 1,
            fromMs: cue.startMs - 80,
            toMs: cue.endMs,
            track: { x: [[0, x]], y: [[0, top + BASELINE_EM * size]], o: [[word.startMs - FADE_MS, 0], [word.startMs, 1]] },
            text: word.text,
            face: FACE,
            sizePx: size,
            letterSpacingEm: 0,
            fill: word.role === "hero" ? input.colours.highlight : input.colours.primary,
            shadows: [{ dx: 0, dy: 4 * space.u, blur: 8 * space.u, colour: input.colours.shadow, alpha: 0.6 }],
            anchor: "baseline-left",
            language: cue.language,
          });
          x += boxes[at]! + gap;
        }
        top += LINE_EM * size;
      }
      pieces.push(...clampToSafeArea(cuePieces, space.safe, input.measure));
    }
    return { pieces };
  },
};
