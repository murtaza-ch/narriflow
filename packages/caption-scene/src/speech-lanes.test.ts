import { describe, expect, test } from "bun:test";
import type { SceneCue } from "./input";
import { speechWindows } from "./templates/speech-layout";
import { sceneInput } from "./test-support";

const SAFE = { x1: 0, y1: 300, x2: 1080, y2: 1700 };
const cue = (index: number, speaker: number | null, words: [string, number, number][]): SceneCue => ({
  index,
  startMs: words[0]![1],
  endMs: words.at(-1)![2],
  speaker,
  language: "en",
  words: words.map(([text, startMs, endMs]) => ({ text, startMs, endMs, role: "body", key: null })),
});

describe("speech lanes", () => {
  // The owner's clip: "of" ends at 1630 ms but the same speaker's next cue starts at 1570 ms. Before, that 60 ms of
  // transcript overlap split one sentence into two lanes ("up with some of" high, "our" low).
  test("one speaker's overlapping cues stay in one lane, the earlier cut at the next onset", () => {
    const cues = [
      cue(0, 2, [["up", 1090, 1270], ["with", 1270, 1430], ["some", 1430, 1530], ["of", 1530, 1630]]),
      cue(1, 2, [["our", 1570, 1710], ["favorite", 1710, 1970], ["moments", 1970, 2310]]),
    ];
    const windows = speechWindows(sceneInput(cues, { fps: 30 }), SAFE, 0, 150);
    expect(windows.map((w) => w.lane)).toEqual([0, 0]);
    expect(windows.map((w) => w.bounds)).toEqual([SAFE, SAFE]);
    expect(windows[0]!.to).toBe(1570);
  });

  test("unknown speakers (dubs) are one voice too", () => {
    const cues = [cue(0, null, [["one", 0, 500]]), cue(1, null, [["two", 450, 900]])];
    expect(speechWindows(sceneInput(cues, { fps: 30 }), SAFE, 0, 150).map((w) => w.lane)).toEqual([0, 0]);
  });

  test("different speakers who overlap still get their own lanes", () => {
    const cues = [cue(0, 0, [["first", 357, 657], ["late", 657, 957]]), cue(1, 1, [["wait", 887, 1187]])];
    const windows = speechWindows(sceneInput(cues, { fps: 30 }), SAFE, 0, 150);
    expect(windows.map((w) => w.lane)).toEqual([0, 1]);
    expect(windows[0]!.bounds.y2).toBeLessThan(SAFE.y2);
  });
});
