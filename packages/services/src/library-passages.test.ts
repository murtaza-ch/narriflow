import { describe, expect, test } from "bun:test";
import { chunkUtterances, PASSAGE_MAX_MS, PASSAGE_MIN_MS } from "./library-passages";

function utterance(startSec: number, endSec: number, text = `said at ${startSec}`) {
  return { startSec, endSec, text };
}

/** Back-to-back utterances of `length` seconds each. */
function run(count: number, length: number, start = 0) {
  return Array.from({ length: count }, (_, index) => utterance(start + index * length, start + (index + 1) * length, `sentence ${index}`));
}

describe("chunkUtterances", () => {
  test("returns nothing for an empty or blank transcript", () => {
    expect(chunkUtterances([])).toEqual([]);
    expect(chunkUtterances([utterance(0, 5, "   ")])).toEqual([]);
  });

  test("closes a passage at the first utterance boundary past the minimum", () => {
    const passages = chunkUtterances(run(10, 8));
    // Four 8-second sentences reach 32 seconds.
    expect(passages.map((passage) => [passage.startMs, passage.endMs])).toEqual([[0, 32_000], [32_000, 64_000], [64_000, 80_000]]);
    expect(passages[0]!.text).toBe("sentence 0 sentence 1 sentence 2 sentence 3");
  });

  test("never splits an utterance and never exceeds the maximum when it can avoid it", () => {
    const passages = chunkUtterances([utterance(0, 29), utterance(29, 69), utterance(69, 75)]);
    // The 40-second sentence would take the first passage to 69 seconds.
    expect(passages.map((passage) => [passage.startMs, passage.endMs])).toEqual([[0, 29_000], [29_000, 69_000], [69_000, 75_000]]);
    for (const passage of chunkUtterances(run(40, 7))) {
      expect(passage.endMs - passage.startMs).toBeLessThanOrEqual(PASSAGE_MAX_MS);
    }
  });

  test("keeps a single utterance longer than the maximum whole", () => {
    const [passage, ...rest] = chunkUtterances([utterance(10, 100, "a very long answer")]);
    expect(rest).toEqual([]);
    expect([passage?.startMs, passage?.endMs, passage?.text]).toEqual([10_000, 100_000, "a very long answer"]);
  });

  test("keeps a short remainder as its own passage", () => {
    const passages = chunkUtterances([...run(4, 8), utterance(32, 34, "thanks for watching")]);
    expect(passages).toHaveLength(2);
    expect(passages[1]).toMatchObject({ startMs: 32_000, endMs: 34_000, text: "thanks for watching" });
  });

  test("covers the transcript in order without overlap", () => {
    const passages = chunkUtterances(run(37, 6.5));
    for (let index = 1; index < passages.length; index++) {
      expect(passages[index]!.startMs).toBe(passages[index - 1]!.endMs);
    }
    expect(passages.at(-1)!.endMs).toBe(Math.round(37 * 6.5 * 1000));
    for (const passage of passages.slice(0, -1)) expect(passage.endMs - passage.startMs).toBeGreaterThanOrEqual(PASSAGE_MIN_MS);
  });

  test("is deterministic, and a hash changes only with the span or wording", () => {
    const utterances = run(12, 9);
    const first = chunkUtterances(utterances);
    expect(chunkUtterances(utterances)).toEqual(first);
    expect(new Set(first.map((passage) => passage.contentHash)).size).toBe(first.length);

    const edited = chunkUtterances(utterances.map((item, index) => (index === 5 ? { ...item, text: "a different sentence" } : item)));
    expect(edited.map((passage, index) => passage.contentHash === first[index]!.contentHash)).toEqual(first.map((_, index) => index !== 1));
  });

  test("normalizes whitespace and ignores blank utterances", () => {
    const passages = chunkUtterances([utterance(0, 20, "  hello \n  there "), utterance(20, 21, ""), utterance(21, 40, "again")]);
    expect(passages).toHaveLength(1);
    expect(passages[0]).toMatchObject({ startMs: 0, endMs: 40_000, text: "hello there again" });
  });

  test("does not let overlapping utterances move a passage end backwards", () => {
    const [passage] = chunkUtterances([utterance(0, 20), utterance(5, 12), utterance(12, 35)]);
    expect([passage?.startMs, passage?.endMs]).toEqual([0, 35_000]);
  });
});
