import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { countUpText, detectList, detectPunchlines, parseNumberInWord, pauseAfterMs, pauseBeforeMs, speechRate } from "./detect";
import { CAPTION_SCENE_PROGRAMS } from "./registry";

const cuesOf = (name: keyof typeof CAPTION_SCENE_PROGRAMS) => demoCues(CAPTION_SCENE_PROGRAMS[name].demo).cues;

describe("detectors", () => {
  test("pauses between cues", () => {
    const cues = cuesOf("lyrics");
    expect(pauseBeforeMs(cues, 0)).toBe(0);
    expect(pauseAfterMs(cues, cues.length - 1)).toBe(Number.POSITIVE_INFINITY);
    // The sample's "honestly?" cue follows a 1080 ms pause.
    const honestly = cues.findIndex((cue) => cue.words[0]!.text === "honestly?");
    expect(pauseBeforeMs(cues, honestly)).toBeGreaterThan(1000);
  });

  test("a list: total from 'three mistakes', items from first/second/finally, end at 'so'", () => {
    const { events, total, listOpen } = detectList(cuesOf("index"));
    expect(total).toBe(3);
    expect(events.map((event) => event.type)).toEqual(["total", "item", "item", "item", "end"]);
    expect(events.filter((event) => event.type === "item").map((event) => (event.type === "item" ? event.n : 0))).toEqual([1, 2, 3]);
    expect(listOpen).toEqual([true, true, true, true, false]);
    expect(detectList(cuesOf("reveal")).total).toBeNull();
  });

  test("a list item may start a phrase inside a cue, never a stray 'first'", () => {
    const cue = (...words: string[]) => demoCues({ lines: [words.join(" ")] }).cues[0]!;
    const open = cue("three", "tips", "for", "you");
    const kinds = (next: ReturnType<typeof cue>) => detectList([open, next]).events.map((event) => event.type);
    expect(kinds(cue("channel.", "First,", "sleep"))).toEqual(["total", "item"]);
    expect(kinds(cue("the", "first", "time", "I"))).toEqual(["total"]);
  });

  test("numbers inside words count up", () => {
    expect(parseNumberInWord("312%")).toEqual({ pre: "", value: 312, decimals: 0, post: "%" });
    expect(parseNumberInWord("$4.2M")).toEqual({ pre: "$", value: 4.2, decimals: 1, post: "M" });
    expect(parseNumberInWord("day")).toBeNull();
    expect(countUpText(parseNumberInWord("$4.2M")!, 0.5)).toBe("$2.1M");
    expect(countUpText(parseNumberInWord("312%")!, 1)).toBe("312%");
  });

  test("speech rate sets the lean and the speed lines", () => {
    const [slow, fast] = [
      demoCues({ lines: ["a:b@600 b:b@600"] }).cues[0]!,
      demoCues({ lines: ["a:b@100 b:b@100 c:b@100 d:b@100 e:b@100 f:b@100"], options: { gap: 10 } }).cues[0]!,
    ];
    expect(speechRate(slow).lines).toBe(0);
    expect(speechRate(fast).lines).toBe(4);
    expect(speechRate(fast).lean).toBeLessThan(speechRate(slow).lean);
    expect(speechRate(fast).lean).toBeGreaterThanOrEqual(-0.32);
  });

  test("a punchline: a short sentence-ending line after a real pause", () => {
    const punch = detectPunchlines(cuesOf("punchline"));
    expect(punch.map((entry) => entry.punch)).toEqual([false, false, true, false]);
    // The line before a punchline leaves early to give the drumroll the stage.
    expect(punch[1]!.showUntilMs).toBeLessThan(cuesOf("punchline")[1]!.endMs);
  });
});
