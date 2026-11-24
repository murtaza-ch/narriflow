import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { CAPTION_SCENE_PROGRAMS } from "./registry";
import { type Box, type Piece, pieceBounds } from "./scene";
import { sceneInput } from "./test-support";

const LINES = [
  "it's time:h@560",
  "to say goodbye:h@560",
  "to the waveform studio:h@600",
  "even still:m work:h@560",
  "work:h@600",
  "dead:h@500 is:m it:m",
  "of them are unplugged:h@600",
  "start today:h@600",
  "make it:m yours:h@560",
  "people remember how:m it:m felt:h@560",
];

const touches = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

function build(line: string) {
  const { cues } = demoCues({ lines: [line] });
  const input = sceneInput(cues, { fps: 60 });
  return { cues, input, pieces: CAPTION_SCENE_PROGRAMS.mdrn.program.build(input).pieces };
}

describe("Mdrn keeps its marks in free space", () => {
  test.each(LINES)("the asterisk and dash never touch lettering or each other: %s", (line) => {
    const { cues, input, pieces } = build(line);
    const marks = pieces.filter((piece) => /:(asterisk\d+|dash)$/.test(piece.id));
    const others = (mark: Piece) => pieces.filter((piece) => piece !== mark && (piece.kind === "text" || /:(asterisk\d+|dash)$/.test(piece.id)));
    expect(marks.length).toBeGreaterThan(0);
    const cue = cues[0]!;
    for (const t of exportFrameTimes(cue.startMs, cue.endMs, input.fps)) {
      for (const mark of marks) {
        const box = pieceBounds(mark, t, input.measure);
        if (!box) continue;
        for (const other of others(mark)) {
          const ink = pieceBounds(other, t, input.measure);
          if (ink && touches(box, ink)) throw new Error(`${mark.id} touches ${other.id} at ${t} ms`);
        }
      }
    }
  });

  test("a hero that opens the cue ends it in the asterisk alone, without a dash", () => {
    const { pieces } = build("work:h@600");
    expect(pieces.some((piece) => piece.id.endsWith(":asterisk0"))).toBe(true);
    expect(pieces.some((piece) => piece.id.endsWith(":dash"))).toBe(false);
  });

  test("the asterisk follows its hero on the hero's capital line and the dash closes the first row", () => {
    const { cues, input, pieces } = build("make it:m yours:h@560");
    const t = cues[0]!.endMs - 60;
    const hero = pieceBounds(pieces.find((piece) => piece.id === "mdrn:0:w2")!, t, input.measure)!;
    const star = pieceBounds(pieces.find((piece) => piece.id === "mdrn:0:asterisk2")!, t, input.measure)!;
    const dash = pieceBounds(pieces.find((piece) => piece.id === "mdrn:0:dash")!, t, input.measure)!;
    const first = pieceBounds(pieces.find((piece) => piece.id === "mdrn:0:w0")!, t, input.measure)!;
    expect(star.x1).toBeGreaterThanOrEqual(hero.x2);
    expect(star.y1).toBeGreaterThanOrEqual(hero.y1 - 4);
    expect(dash.x1).toBeGreaterThan(first.x2);
    expect(dash.y1).toBeLessThan(first.y2);
  });
});

describe("Mdrn sizes and indent", () => {
  const faces = (pieces: readonly Piece[]) => pieces.filter((piece): piece is Extract<Piece, { kind: "text" }> => piece.kind === "text" && /:w\d+$/.test(piece.id));

  test("rows keep the sample's size ratio inside a cue", () => {
    for (const line of LINES) {
      const { cues, pieces } = build(line);
      const sizes = faces(pieces).map((piece) => ({ role: cues[0]!.words[Number(/:w(\d+)$/.exec(piece.id)![1])]!.role, size: piece.sizePx }));
      const hero = sizes.find((entry) => entry.role === "hero");
      const body = sizes.find((entry) => entry.role === "body");
      if (hero && body) expect(hero.size / body.size).toBeCloseTo(171.5 / 134, 2);
    }
  });

  test("short rows are not shrunk where a wrap or a squeeze would do", () => {
    const { pieces } = build("even still:m work:h@560");
    const body = faces(pieces).find((piece) => piece.id === "mdrn:0:w0")!;
    expect(body.sizePx).toBeGreaterThanOrEqual(134 * 0.8);
  });

  test("a staggered row steps in by the sample's indent and everything stays inside the safe area", () => {
    for (const line of LINES) {
      const { cues, input, pieces } = build(line);
      const t = cues[0]!.endMs - 60;
      const lefts = new Map<number, number>();
      for (const piece of faces(pieces)) {
        const box = pieceBounds(piece, t, input.measure)!;
        expect(box.x1).toBeGreaterThanOrEqual(input.canvas.width * 0.02);
        expect(box.x2).toBeLessThanOrEqual(input.canvas.width * 0.98);
        const row = Math.round((box.y1 + box.y2) / 2);
        lefts.set(row, Math.min(lefts.get(row) ?? Infinity, box.x1));
      }
      const starts = [...lefts.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x);
      for (const x of starts.slice(1)) expect(x).toBeGreaterThanOrEqual(starts[0]! - 2);
    }
  });
});
