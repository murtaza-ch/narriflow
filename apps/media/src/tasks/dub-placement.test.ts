import { describe, expect, test } from "bun:test";
import { CLIP_AUDIO_FADE_OUT_SEC } from "@narriflow/composition-plan";
import {
  dubCaptionWords,
  GAP,
  LATE_MAX,
  placeDubSegments,
  TEMPO_MAX,
} from "./dub-placement";

describe("placeDubSegments", () => {
  test("exports the spec constants", () => {
    expect([GAP, LATE_MAX, TEMPO_MAX]).toEqual([0.08, 0.6, 1.3]);
  });

  test("clips that fit start at their source sentence at tempo 1", () => {
    const result = placeDubSegments({
      editedDurationSec: 10,
      segments: [
        { startSec: 0.5, naturalSec: 2 },
        { startSec: 4, naturalSec: 3 },
      ],
    });
    expect(result).toEqual({
      kind: "placed",
      segments: [
        { startSec: 0.5, endSec: 2.5, tempo: 1 },
        { startSec: 4, endSec: 7, tempo: 1 },
      ],
    });
  });

  test("a clip longer than its window speeds up and still ends inside the deadline", () => {
    const result = placeDubSegments({
      editedDurationSec: 20,
      segments: [
        { startSec: 0, naturalSec: 3 },
        { startSec: 2.5, naturalSec: 1 },
      ],
    });
    if (result.kind !== "placed") throw new Error("expected placed");
    const [first, second] = result.segments;
    // deadline_0 = 2.5 + 0.6 - 0.08 = 3.02, so tempo = 3 / 3.02 < 1 -> 1
    expect(first).toEqual({ startSec: 0, endSec: 3, tempo: 1 });
    expect(second.startSec).toBeCloseTo(3.08, 9);
    expect(second.tempo).toBe(1);
  });

  test("tempo above 1 divides the natural length", () => {
    const result = placeDubSegments({
      editedDurationSec: 20,
      segments: [
        { startSec: 0, naturalSec: 3.5 },
        { startSec: 2.5, naturalSec: 1 },
      ],
    });
    if (result.kind !== "placed") throw new Error("expected placed");
    const first = result.segments[0];
    expect(first.tempo).toBeCloseTo(3.5 / 3.02, 9);
    expect(first.tempo).toBeGreaterThan(1);
    expect(first.endSec).toBeCloseTo(3.02, 9);
  });

  test("a late start is carried by at most LATE_MAX and the next segment recovers", () => {
    const result = placeDubSegments({
      editedDurationSec: 20,
      segments: [
        { startSec: 0, naturalSec: 1.8 },
        { startSec: 1, naturalSec: 1 },
        { startSec: 10, naturalSec: 1 },
      ],
    });
    if (result.kind !== "placed") throw new Error("expected placed");
    // 0: deadline 1.52, tempo 1.8/1.52 -> ends at 1.52; 1: starts 1.6 = 1 + LATE_MAX
    expect(result.segments[0].endSec).toBeCloseTo(1.52, 9);
    expect(result.segments[1].startSec).toBeCloseTo(1 + LATE_MAX, 9);
    expect(result.segments[2].startSec).toBe(10);
  });

  test("unfit when the previous segment pushes the start to or past the deadline", () => {
    const result = placeDubSegments({
      editedDurationSec: 20,
      segments: [
        { startSec: 0, naturalSec: 3.9 },
        { startSec: 1, naturalSec: 0.2 },
        { startSec: 2, naturalSec: 1 },
      ],
    });
    // segment 0: deadline 1.52, tempo 3.9 / 1.52 > 1.3
    expect(result).toEqual({ kind: "unfit", segmentIndex: 0 });
  });

  test("unfit when the deadline does not leave room after the previous end", () => {
    const result = placeDubSegments({
      editedDurationSec: 20,
      segments: [
        { startSec: 0, naturalSec: 1.9 },
        { startSec: 1, naturalSec: 1 },
        { startSec: 1.2, naturalSec: 1 },
      ],
    });
    // 0: deadline 1.52, tempo 1.25 -> end 1.52; 1: start 1.6, deadline 1.2+0.52=1.72, tempo 1/0.12 > 1.3
    expect(result).toEqual({ kind: "unfit", segmentIndex: 1 });
    expect(
      placeDubSegments({
        editedDurationSec: 20,
        segments: [
          { startSec: 0, naturalSec: 0.5 },
          { startSec: 0.5, naturalSec: 1 },
          { startSec: 0.5, naturalSec: 1 },
        ],
      }),
    ).toEqual({ kind: "unfit", segmentIndex: 1 });
  });

  test("deadline <= start is unfit when the previous end plus GAP passes the deadline", () => {
    expect(
      placeDubSegments({
        editedDurationSec: 20,
        segments: [
          { startSec: 0, naturalSec: 1.5 },
          { startSec: 1, naturalSec: 0 },
          { startSec: 1, naturalSec: 1 },
        ],
      }),
    ).toEqual({ kind: "unfit", segmentIndex: 1 });
  });

  test("tempo exactly over the cap is unfit and the cap itself fits", () => {
    // The last segment must end before the closing click-guard fade: 2.12 s leaves 2 s of speech.
    expect(
      placeDubSegments({ editedDurationSec: 2.12, segments: [{ startSec: 0, naturalSec: 2 * 1.3 + 0.01 }] }),
    ).toEqual({ kind: "unfit", segmentIndex: 0 });
    const ok = placeDubSegments({ editedDurationSec: 2.12, segments: [{ startSec: 0, naturalSec: 2.5 }] });
    expect(ok.kind).toBe("placed");
  });

  test("the last segment ends before the clip's closing fade", () => {
    const fits = placeDubSegments({
      editedDurationSec: 5.12,
      segments: [{ startSec: 3, naturalSec: 2.5 }],
    });
    if (fits.kind !== "placed") throw new Error("expected placed");
    expect(fits.segments[0].tempo).toBeCloseTo(1.25, 9);
    expect(fits.segments[0].endSec).toBeCloseTo(5, 9);
    expect(
      placeDubSegments({ editedDurationSec: 5.12, segments: [{ startSec: 3, naturalSec: 3 }] }),
    ).toEqual({ kind: "unfit", segmentIndex: 0 });
    expect(
      placeDubSegments({ editedDurationSec: 5, segments: [{ startSec: 5, naturalSec: 0.1 }] }),
    ).toEqual({ kind: "unfit", segmentIndex: 0 });
  });

  test("an empty plan places nothing", () => {
    expect(placeDubSegments({ editedDurationSec: 5, segments: [] })).toEqual({ kind: "placed", segments: [] });
  });

  test("random plans never start later than source + LATE_MAX, overlap, or run past the clip", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let placedPlans = 0;
    for (let round = 0; round < 2000; round += 1) {
      const count = 1 + Math.floor(random() * 8);
      let at = random() * 2;
      const segments = Array.from({ length: count }, () => {
        const startSec = at;
        at += 0.3 + random() * 4;
        return { startSec, naturalSec: 0.2 + random() * 4 };
      });
      const editedDurationSec = at + random() * 3;
      const result = placeDubSegments({ editedDurationSec, segments });
      if (result.kind === "unfit") {
        expect(result.segmentIndex).toBeGreaterThanOrEqual(0);
        expect(result.segmentIndex).toBeLessThan(count);
        continue;
      }
      placedPlans += 1;
      result.segments.forEach((placed, index) => {
        expect(placed.startSec).toBeGreaterThanOrEqual(segments[index].startSec - 1e-9);
        expect(placed.startSec).toBeLessThanOrEqual(segments[index].startSec + LATE_MAX + 1e-9);
        expect(placed.tempo).toBeGreaterThanOrEqual(1);
        expect(placed.tempo).toBeLessThanOrEqual(TEMPO_MAX);
        expect(placed.endSec).toBeLessThanOrEqual(editedDurationSec - CLIP_AUDIO_FADE_OUT_SEC + 1e-9);
        if (index > 0) expect(placed.startSec).toBeGreaterThanOrEqual(result.segments[index - 1].endSec + GAP - 1e-9);
      });
    }
    expect(placedPlans).toBeGreaterThan(100);
  });
});

function check(words: ReturnType<typeof dubCaptionWords>, startSec: number, endSec: number) {
  expect(words.length).toBeGreaterThan(0);
  expect(words[0].startSec).toBe(startSec);
  expect(words.at(-1)?.endSec).toBe(endSec);
  let previous = startSec;
  for (const word of words) {
    expect(word.startSec).toBeGreaterThanOrEqual(previous);
    expect(word.endSec).toBeGreaterThanOrEqual(word.startSec);
    expect(word.endSec).toBeLessThanOrEqual(endSec);
    previous = word.endSec;
  }
}

const rejoin = (words: ReturnType<typeof dubCaptionWords>) =>
  words.map((word, index) => (index > 0 && word.spaceBefore ? " " : "") + word.text).join("");

describe("dubCaptionWords", () => {
  test("spanish attaches punctuation to the previous word and keeps spacing", () => {
    const words = dubCaptionWords("¿Cómo estás, amigo? ¡Muy bien!", "es", 2, 6);
    expect(words.map((w) => w.text)).toEqual(["¿Cómo", "estás,", "amigo?", "¡Muy", "bien!"]);
    expect(words.map((w) => w.spaceBefore)).toEqual([false, true, true, true, true]);
    check(words, 2, 6);
  });

  test("time is proportional to grapheme count", () => {
    const words = dubCaptionWords("aa bbbb", "es", 0, 6);
    expect(words[0]).toMatchObject({ startSec: 0, endSec: 2 });
    expect(words[1]).toMatchObject({ startSec: 2, endSec: 6 });
  });

  test("urdu splits on spaces and keeps the urdu full stop attached", () => {
    const text = "یہ ایک مثال ہے۔ شکریہ!";
    const words = dubCaptionWords(text, "ur", 1, 5);
    expect(words.map((w) => w.text)).toEqual(["یہ", "ایک", "مثال", "ہے۔", "شکریہ!"]);
    expect(rejoin(words)).toBe(text);
    check(words, 1, 5);
  });

  test("arabic keeps the arabic comma and question mark attached", () => {
    const text = "مرحبا، كيف حالك؟";
    const words = dubCaptionWords(text, "ar", 0, 3);
    expect(words.map((w) => w.text)).toEqual(["مرحبا،", "كيف", "حالك؟"]);
    expect(rejoin(words)).toBe(text);
    check(words, 0, 3);
  });

  test("hindi keeps the danda attached and combining marks stay in one grapheme", () => {
    const text = "यह एक उदाहरण है। धन्यवाद";
    const words = dubCaptionWords(text, "hi", 0, 4);
    expect(words.map((w) => w.text)).toEqual(["यह", "एक", "उदाहरण", "है।", "धन्यवाद"]);
    expect(rejoin(words)).toBe(text);
    check(words, 0, 4);
  });

  test("chinese has no spaces and splits into words", () => {
    const text = "今天天气很好，我们去公园吧。";
    const words = dubCaptionWords(text, "zh", 3, 9);
    expect(words.length).toBeGreaterThan(2);
    expect(words.every((w) => !w.spaceBefore)).toBe(true);
    expect(rejoin(words)).toBe(text);
    expect(words.some((w) => w.text.endsWith("，"))).toBe(true);
    expect(words.at(-1)?.text.endsWith("。")).toBe(true);
    check(words, 3, 9);
  });

  test("japanese has no spaces and attaches the full stop", () => {
    const text = "これはテストです。ありがとう！";
    const words = dubCaptionWords(text, "ja", 0, 5);
    expect(words.length).toBeGreaterThan(2);
    expect(words.every((w) => !w.spaceBefore)).toBe(true);
    expect(rejoin(words)).toBe(text);
    expect(words.some((w) => w.text.endsWith("。"))).toBe(true);
    check(words, 0, 5);
  });

  test("a standalone dash stays on the previous token with its space", () => {
    const words = dubCaptionWords("one - two", "en", 0, 3);
    expect(words.map((w) => w.text)).toEqual(["one -", "two"]);
    expect(rejoin(words)).toBe("one - two");
  });

  test("punctuation only text is one token and empty text has none", () => {
    expect(dubCaptionWords("...", "en", 1, 2)).toEqual([
      { text: "...", spaceBefore: false, startSec: 1, endSec: 2 },
    ]);
    expect(dubCaptionWords("   ", "en", 1, 2)).toEqual([]);
  });

  test("a collapsed or reversed range stays inside [startSec, startSec]", () => {
    const words = dubCaptionWords("hola mundo", "es", 4, 3);
    check(words, 4, 4);
  });
});
