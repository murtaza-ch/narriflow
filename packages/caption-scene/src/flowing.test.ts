import { expect, test } from "bun:test";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { CAPTION_SCENE_PROGRAMS } from "./registry";
import { pieceBounds } from "./scene";
import { sceneInput } from "./test-support";

const build = (lines: string[]) => {
  const { cues } = demoCues({ lines, options: { rate: 270, lead: 400, cueGap: 140, tail: 800 } });
  const input = sceneInput(cues, { fps: 30 });
  return { cues, input, pieces: CAPTION_SCENE_PROGRAMS.flowing.program.build(input).pieces };
};

test("Flowing's chip types out with the speech: a sliver at the first word, then one word wider at a time", () => {
  const { cues, input, pieces } = build(["the:m best:b ideas:b look:b"]);
  const cue = cues[0]!;
  const chip = pieces.find((piece) => piece.id === "flowing:0:chip0")!;
  const width = (t: number) => {
    const box = pieceBounds(chip, t, input.measure)!;
    return box.x2 - box.x1;
  };
  const final = width(cue.endMs - 200);
  expect(width(chip.fromMs)).toBeLessThan(0.25 * final);
  let last = 0;
  for (const word of cue.words) {
    const at = width(word.startMs + 400);
    expect(at).toBeGreaterThan(last);
    last = at;
    // The chip never lags behind or runs far ahead of the word it carries.
    const text = pieces.find((piece) => piece.id === `flowing:0:w${cue.words.indexOf(word)}`)!;
    const ink = pieceBounds(text, word.startMs + 400, input.measure)!;
    expect(ink.x2).toBeLessThanOrEqual(pieceBounds(chip, word.startMs + 400, input.measure)!.x2 + 1);
  }
  expect(width(cue.words[1]!.startMs - 60)).toBeLessThan(width(cue.words[1]!.startMs + 400));
});

test("Flowing keeps the words before and after the key word in one chip in spoken order", () => {
  const { cues, input, pieces } = build(["the:m remote:b doesn't:h@900 work.:b"]);
  const cue = cues[0]!;
  const t = cue.endMs - 250;
  const box = (id: string) => pieceBounds(pieces.find((piece) => piece.id === `flowing:0:${id}`)!, t, input.measure)!;
  const [the, remote, hero, work] = ["w0", "w1", "w2l0", "w3"].map(box);
  // Key word on top; the three others share one row below it, left to right in speech order.
  expect(hero!.y2).toBeLessThanOrEqual(the!.y1);
  expect(Math.abs(the!.y2 - remote!.y2)).toBeLessThan(20);
  expect(Math.abs(remote!.y2 - work!.y2)).toBeLessThan(20);
  expect(the!.x2).toBeLessThan(remote!.x1);
  expect(remote!.x2).toBeLessThan(work!.x1);
  expect(pieces.filter((piece) => /^flowing:0:chip\d+$/.test(piece.id))).toHaveLength(1);
});

test("Flowing's chip words enter on their baseline, with no vertical offset", () => {
  const { cues, input, pieces } = build(["the:m best:b ideas:b look:b"]);
  for (const [at, word] of cues[0]!.words.entries()) {
    const text = pieces.find((piece) => piece.id === `flowing:0:w${at}`)!;
    const bottoms = exportFrameTimes(text.fromMs, word.endMs, input.fps ?? 30).map((t) => pieceBounds(text, t, input.measure)!.y2);
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(0.5);
  }
});
