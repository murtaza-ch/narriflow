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

const boxAt = (pieces: ReturnType<typeof build>["pieces"], input: ReturnType<typeof build>["input"], id: string, t: number) =>
  pieceBounds(pieces.find((piece) => piece.id === `flowing:0:${id}`)!, t, input.measure)!;

test("Flowing reads in spoken order top to bottom: lead chip, key word alone, tail chip", () => {
  const { cues, input, pieces } = build(["the:m remote:b doesn't:h@900 work.:b"]);
  const t = cues[0]!.endMs - 250;
  const [the, remote, hero, work] = ["w0", "w1", "w2l0", "w3"].map((id) => boxAt(pieces, input, id, t));
  // The words before the key word share one row above it, left to right.
  expect(Math.abs(the!.y2 - remote!.y2)).toBeLessThan(20);
  expect(the!.x2).toBeLessThan(remote!.x1);
  expect(Math.max(the!.y2, remote!.y2)).toBeLessThanOrEqual(hero!.y1);
  // The key word sits alone, and the words after it come below it.
  expect(hero!.y2).toBeLessThanOrEqual(work!.y1);
  // One chip per ordinary run: lead above, tail below.
  expect(pieces.filter((piece) => /^flowing:0:chip\d+$/.test(piece.id))).toHaveLength(2);
});

test("Flowing puts a key word spoken first on top, with the rest of the cue in one chip below", () => {
  const { cues, input, pieces } = build(["stop:h@900 the:m clock:b now:b"]);
  const t = cues[0]!.endMs - 250;
  const hero = boxAt(pieces, input, "w0l0", t);
  const rest = ["w1", "w2", "w3"].map((id) => boxAt(pieces, input, id, t));
  expect(hero.y2).toBeLessThanOrEqual(Math.min(...rest.map((box) => box.y1)));
  for (const [i, box] of rest.entries()) {
    expect(Math.abs(box.y2 - rest[0]!.y2)).toBeLessThan(20);
    if (i) expect(rest[i - 1]!.x2).toBeLessThan(box.x1);
  }
  expect(pieces.filter((piece) => /^flowing:0:chip\d+$/.test(piece.id))).toHaveLength(1);
});

test("Flowing alternates chip and key rows when a cue has two key words, and keeps a keyless cue in one chip", () => {
  const two = build(["so:m ship:h@900 it:m now:h@900"]);
  const t = two.cues[0]!.endMs - 250;
  const ys = [
    boxAt(two.pieces, two.input, "w0", t),
    boxAt(two.pieces, two.input, "w1l0", t),
    boxAt(two.pieces, two.input, "w2", t),
    boxAt(two.pieces, two.input, "w3l0", t),
  ].map((box) => box.y1);
  expect(ys).toEqual([...ys].sort((a, b) => a - b));
  expect(new Set(ys).size).toBe(4);
  const none = build(["the:m best:b ideas:b look:b"]);
  expect(none.pieces.filter((piece) => /^flowing:0:chip\d+$/.test(piece.id))).toHaveLength(1);
});

test("Flowing's chip words enter on their baseline, with no vertical offset", () => {
  const { cues, input, pieces } = build(["the:m best:b ideas:b look:b"]);
  for (const [at, word] of cues[0]!.words.entries()) {
    const text = pieces.find((piece) => piece.id === `flowing:0:w${at}`)!;
    const bottoms = exportFrameTimes(text.fromMs, word.endMs, input.fps ?? 30).map((t) => pieceBounds(text, t, input.measure)!.y2);
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(0.5);
  }
});
