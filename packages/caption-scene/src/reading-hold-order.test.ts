import { describe, expect, test } from "bun:test";
import type { SceneCue } from "./input";
import type { TextPiece } from "./scene";
import { renderWithReadingHolds, type SpeechWindow } from "./templates/speech-layout";
import { sceneInput } from "./test-support";

// Two sequential sentences: the first ends at 1000 ms, the next starts 40 ms later. Each window draws one word at a
// fixed height, so the test controls whether the held sentence sits above or below the one that follows it.
const cue = (index: number, text: string, startMs: number, endMs: number): SceneCue => ({
  index,
  startMs,
  endMs,
  speaker: null,
  language: "en",
  words: [{ text, startMs, endMs, role: "body", key: null }],
});
const HOLD = 400;

function holdEnd(heldY: number, nextY: number): number {
  const cues = [cue(0, "studio", 600, 1000), cue(1, "out", 1040, 1600)];
  const input = sceneInput(cues, { fps: 30 });
  const safe = { x1: 0, y1: 0, x2: 1080, y2: 1920 };
  const windows: SpeechWindow[] = [
    { cue: cues[0]!, index: 0, start: 600, spokenEnd: 1000, from: 600, to: 1040, lane: 0, bounds: safe },
    { cue: cues[1]!, index: 1, start: 1040, spokenEnd: 1600, from: 1040, to: 2000, lane: 0, bounds: safe },
  ];
  const pieces = renderWithReadingHolds(windows, input, HOLD, (w): TextPiece[] => [{
    id: `w${w.index}`,
    kind: "text",
    z: 1,
    fromMs: w.from,
    toMs: w.to,
    text: w.cue.words[0]!.text,
    face: "Inter Tight Bold",
    sizePx: 80,
    letterSpacingEm: 0,
    fill: "#FFF",
    anchor: "baseline-center",
    track: { x: [[0, 540]], y: [[0, w.index === 0 ? heldY : nextY]] },
  }]);
  return pieces.find((piece) => piece.id === "w0")!.toMs;
}

describe("reading holds keep reading order", () => {
  test("a held sentence above the next one keeps its hold", () => {
    expect(holdEnd(800, 1200)).toBe(1000 + HOLD);
  });

  test("a held sentence below the next one is cut when the next one paints", () => {
    expect(holdEnd(1200, 800)).toBe(1040);
  });
});
