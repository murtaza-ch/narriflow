import { expect, test } from "bun:test";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { CAPTION_SCENE_PROGRAMS } from "./registry";
import { evaluatePiece, pieceBounds } from "./scene";
import { sceneInput } from "./test-support";

const build = (lines: string[]) => {
  const { cues } = demoCues({ lines, options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
  const input = sceneInput(cues, { fps: 30 });
  return { cues, input, pieces: CAPTION_SCENE_PROGRAMS.pills.program.build(input).pieces };
};

const rowsAt = (lines: string[]) => {
  const { cues, input, pieces } = build(lines);
  const t = cues[0]!.endMs - 200;
  const outlines = cues[0]!.words.map((_, at) => pieceBounds(pieces.find((piece) => piece.id === `pills:0:outline${at}`)!, t, input.measure)!);
  const rows: number[][] = [];
  for (const [at, box] of outlines.entries()) {
    const row = rows.find((r) => Math.abs((outlines[r[0]!]!.y1 + outlines[r[0]!]!.y2) / 2 - (box.y1 + box.y2) / 2) < 30);
    if (row) row.push(at);
    else rows.push([at]);
  }
  return rows.map((row) => row.length);
};

test("Pills fills rows evenly instead of leaving one orphan word", () => {
  expect(rowsAt(["it's:b time:b to:m say:b goodbye:h@900"])).toEqual([2, 2, 1]);
  expect(rowsAt(["does:b the:m remote:b even:b still:h@900"])).toEqual([2, 2, 1]);
  expect(rowsAt(["all:b of:m them:b are:b unplugged.:h@900"])).toEqual([2, 2, 1]);
  expect(rowsAt(["we:m didn't:h@900 want:b"])).toEqual([1, 1, 1]);
  expect(rowsAt(["a:b b:b c:b d:b e:b"])).toEqual([3, 2]);
});

test("Pills sets every word's baseline the sample's distance below its pill centre", () => {
  const { cues, pieces } = build(["nobody:b is:m coming:b to:m save:b you:b", "so:m build:h@900"]);
  for (const cue of cues) {
    const t = cue.endMs - 250;
    for (const [at] of cue.words.entries()) {
      const face = pieces.find((piece) => piece.id === `pills:${cue.index}:w${at}`)!;
      // The baseline, not the ink box, is centred: every word of a size sits the same distance below its pill's middle.
      expect(face.origin!.dy).toBeCloseTo(-0.383 * face.sizePx, 5);
      const pill = pieces.find((piece) => piece.id === `pills:${cue.index}:outline${at}`)!;
      expect(evaluatePiece(face, t).y).toBeCloseTo(evaluatePiece(pill, t).y, 5);
    }
  }
});

test("Pills keeps the circled arrow clear of the pills in the row below the key word", () => {
  const { cues, input, pieces } = build(["the:m remote:b doesn't:h@900 work:b today:b", "so:m build:h@900 it:b"]);
  for (const cue of cues) {
    const heroAt = cue.words.findIndex((word) => word.role === "hero");
    const ring = pieces.find((piece) => piece.id === `pills:${cue.index}:ring${heroAt}`)!;
    const below = cue.words.flatMap((_, at) => at > heroAt ? [at] : []);
    expect(below.length).toBeGreaterThan(0);
    for (const t of exportFrameTimes(ring.fromMs + 400, ring.toMs, 30)) {
      const badge = pieceBounds(ring, t, input.measure);
      if (!badge) continue;
      for (const at of below) {
        const pill = pieceBounds(pieces.find((piece) => piece.id === `pills:${cue.index}:outline${at}`)!, t, input.measure);
        if (!pill) continue;
        const hit = badge.x1 < pill.x2 && pill.x1 < badge.x2 && badge.y1 < pill.y2 && pill.y1 < badge.y2;
        expect(hit, `badge over pill ${at} at ${t}`).toBe(false);
      }
    }
  }
});
