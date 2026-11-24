import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { CAPTION_SCENE_PROGRAMS } from "./registry";
import { type Piece, pieceBounds } from "./scene";
import { sceneInput } from "./test-support";

function build(line: string) {
  const { cues } = demoCues({ lines: [line] });
  const input = sceneInput(cues, { fps: 60 });
  const { pieces } = CAPTION_SCENE_PROGRAMS.manifesto.program.build(input);
  const t = cues[0]!.endMs - 60;
  const faces = pieces.filter((piece): piece is Extract<Piece, { kind: "text" }> => piece.kind === "text" && /:w\d+$/.test(piece.id));
  const boxes = faces.map((piece) => ({ piece, box: pieceBounds(piece, t, input.measure)! }));
  return { cues, input, pieces, boxes, t };
}

const rowsOf = (boxes: ReturnType<typeof build>["boxes"]) => {
  const rows = new Map<number, typeof boxes>();
  for (const entry of boxes) {
    const key = Math.round(entry.piece.track.y![0]![1]);
    rows.set(key, [...(rows.get(key) ?? []), entry]);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row.sort((a, b) => a.box.x1 - b.box.x1));
};

describe("Manifesto on real phrasing", () => {
  test("never letter-spaces a word, alone or in a row", () => {
    for (const line of ["oh:h", "work:h@600", "is it", "a b", "it's been that", "most people wait"]) {
      for (const piece of build(line).pieces) if (piece.kind === "text") expect(piece.letterSpacingEm).toBe(0);
    }
  });

  test("a short row keeps its natural gap and is centred instead of spread across the column", () => {
    const { boxes, input } = build("a b");
    const [row] = rowsOf(boxes);
    expect(row).toHaveLength(2);
    const [first, second] = row!;
    const size = first!.piece.sizePx;
    expect(second!.box.x1 - first!.box.x2).toBeCloseTo(size * 0.2, 0);
    expect((first!.box.x1 + second!.box.x2) / 2).toBeCloseTo(input.canvas.width / 2, 0);
  });

  test("a row that fills the column is justified edge to edge", () => {
    const { boxes, input } = build("most people");
    const [row] = rowsOf(boxes);
    expect(row).toHaveLength(2);
    expect(row![1]!.box.x2 - row![0]!.box.x1).toBeCloseTo(Math.min(840, input.canvas.width * 0.9 * 0.84), 0);
  });

  test("the key word's bar is as wide as its own row", () => {
    const { pieces, boxes, t, input } = build("a b:h@500");
    const bar = pieces.find((piece) => piece.id === "manifesto:0:bar0")!;
    const [row] = rowsOf(boxes);
    const wide = row![row!.length - 1]!.box.x2 - row![0]!.box.x1;
    const { x1, x2 } = pieceBounds(bar, t, input.measure)!;
    expect(x2 - x1).toBeCloseTo(wide + 36, 0);
  });

  test("the stack keeps the sample's height budget and every word stays in the frame", () => {
    for (const line of ["to the waveform studio:h@600", "is it dead:h@500", "even still work:h@560", "the remote doesn't work:h@560"]) {
      const { boxes, input } = build(line);
      const top = Math.min(...boxes.map(({ box }) => box.y1));
      const bottom = Math.max(...boxes.map(({ box }) => box.y2));
      expect(bottom - top).toBeLessThanOrEqual(660 + 40);
      for (const { box } of boxes) {
        expect(box.x1).toBeGreaterThanOrEqual(0);
        expect(box.x2).toBeLessThanOrEqual(input.canvas.width);
      }
    }
  });
});
