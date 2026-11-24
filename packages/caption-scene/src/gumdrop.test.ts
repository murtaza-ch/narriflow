import { expect, test } from "bun:test";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { CAPTION_SCENE_PROGRAMS } from "./registry";
import { evaluatePiece, pieceBounds } from "./scene";
import { sceneInput } from "./test-support";

const build = (lines: string[]) => {
  const { cues } = demoCues({ lines, options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } });
  const input = sceneInput(cues, { fps: 30 });
  return { cues, input, pieces: CAPTION_SCENE_PROGRAMS.gumdrop.program.build(input).pieces };
};

test("Gumdrop puts words spoken after the key word right under it and folds the copies away first", () => {
  const { cues, input, pieces } = build(["we:m didn't:h@900 want:b anyone:b"]);
  const cue = cues[0]!;
  const hero = pieces.find((piece) => piece.id === "gumdrop:0:w1")!;
  const tail = pieces.find((piece) => piece.id === "gumdrop:0:w2")!;
  const t = cue.words[2]!.endMs - 20;
  const heroBox = pieceBounds(hero, t, input.measure)!;
  const tailBox = pieceBounds(tail, t, input.measure)!;
  // The tail starts where the key word ends, not a copy stack (1.2 hero sizes) lower.
  expect(tailBox.y1 - heroBox.y2).toBeLessThan(0.5 * (heroBox.y2 - heroBox.y1));
  const copies = pieces.filter((piece) => /^gumdrop:0:w1copy\d$/.test(piece.id));
  expect(copies.length).toBeGreaterThan(0);
  for (const copy of copies) expect(copy.toMs).toBeLessThanOrEqual(tail.fromMs);
});

test("Gumdrop keeps the stacked block inside the caption band with a lead row, hero and tail", () => {
  const { cues, input, pieces } = build(["does:b the:m remote:h@900 even:b still:b", "the:m remote:b doesn't:h@900 work.:b"]);
  for (const cue of cues) {
    const faces = pieces.filter((piece) => new RegExp(`^gumdrop:${cue.index}:(w\\d+|w\\d+copy\\d)$`).test(piece.id));
    for (const [, t] of exportFrameTimes(cue.startMs, cue.endMs, 30).entries()) {
      for (const piece of faces) {
        const box = pieceBounds(piece, t, input.measure);
        if (!box) continue;
        expect(box.y1).toBeGreaterThanOrEqual(0);
        expect(box.y2).toBeLessThanOrEqual(input.canvas.height);
        expect(box.x1).toBeGreaterThanOrEqual(0);
        expect(box.x2).toBeLessThanOrEqual(input.canvas.width);
      }
    }
  }
});

test("Gumdrop's spark never lands on another word of the cue", () => {
  const { cues, input, pieces } = build([
    "it's:b time:b to:m say:b goodbye:h@900",
    "the:m battery:b might:b be:m dead.:h@900",
    "is:m it:m dead?:h@900",
  ]);
  for (const cue of cues) {
    const sparks = pieces.filter((piece) => piece.id.startsWith(`gumdrop:${cue.index}:spark`));
    for (const spark of sparks) {
      const owner = Number(/spark(\d+)/.exec(spark.id)![1]);
      for (const [, t] of exportFrameTimes(cue.startMs, cue.endMs, 30).entries()) {
        const box = pieceBounds(spark, t, input.measure);
        if (!box || !evaluatePiece(spark, t).visible) continue;
        for (const word of pieces.filter((piece) => new RegExp(`^gumdrop:${cue.index}:w\\d+$`).test(piece.id))) {
          if (word.id.endsWith(`:w${owner}`)) continue;
          const other = pieceBounds(word, t, input.measure);
          if (!other) continue;
          const hit = box.x1 < other.x2 && other.x1 < box.x2 && box.y1 < other.y2 && other.y1 < box.y2;
          expect(hit).toBe(false);
        }
      }
    }
  }
});
