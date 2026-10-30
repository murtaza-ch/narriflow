import { describe, expect, test } from "bun:test";
import { captionWordVisualOrder, reorderByLevels, resolveBidiLevels, type CaptionDirection } from "./bidi-order";

/** Words with a space before each but the first, as a provider emits them. */
const line = (texts: string[], direction: CaptionDirection) =>
  captionWordVisualOrder(
    texts.map((text, index) => ({ text, space: index > 0 })),
    direction,
  );

describe("caption word visual order", () => {
  test("pure LTR keeps logical order", () => {
    const order = line(["Hello", "big", "world"], "ltr");
    expect(order.wordOrder).toEqual([0, 1, 2]);
    expect(order.items).toEqual([{ word: 0 }, { space: true }, { word: 1 }, { space: true }, { word: 2 }]);
    expect(order.wordDirections).toEqual(["ltr", "ltr", "ltr"]);
  });

  test("pure RTL runs the words right to left", () => {
    const order = line(["آپ", "کو", "بتایا"], "rtl");
    expect(order.wordOrder).toEqual([2, 1, 0]);
    expect(order.wordDirections).toEqual(["rtl", "rtl", "rtl"]);
  });

  test("an English phrase inside Urdu keeps its own reading order (the Studio showed 'Family Extended')", () => {
    const order = line(["لیے", "Extended", "Family"], "rtl");
    // Left to right: the Latin run first ("Extended Family"), the Urdu word at the right.
    expect(order.wordOrder).toEqual([1, 2, 0]);
    expect(order.items).toEqual([{ word: 1 }, { space: true }, { word: 2 }, { space: true }, { word: 0 }]);
    expect(order.wordDirections).toEqual(["rtl", "ltr", "ltr"]);
  });

  test("Arabic with a number and a Latin name reads each run left to right inside the right-to-left line", () => {
    const order = line(["عام", "2026", "Narriflow", "الجديد"], "rtl");
    // Logical: عام 2026 Narriflow الجديد. The number (AN) and the Latin name are separate runs with a right-to-left
    // space between them (UAX #9 N1/N2), so the line reads الجديد Narriflow 2026 عام from the left.
    expect(order.wordOrder).toEqual([3, 2, 1, 0]);
    expect(order.wordDirections).toEqual(["rtl", "rtl", "ltr", "rtl"]);
  });

  test("Hebrew with numbers: each number reads left to right, the numbers follow the line right to left", () => {
    const order = line(["שלום", "12", "34", "עולם"], "rtl");
    expect(order.wordOrder).toEqual([3, 2, 1, 0]);
  });

  test("an RTL phrase inside an English line is reversed within the LTR line", () => {
    const order = line(["say", "مرحبا", "بالعالم", "now"], "ltr");
    expect(order.wordOrder).toEqual([0, 2, 1, 3]);
  });

  test("neutral punctuation at the ends of a word stays with its word", () => {
    const order = line(["«مرحبا»", "Narriflow!", "…"], "rtl");
    expect(order.wordOrder).toHaveLength(3);
    expect(new Set(order.wordOrder)).toEqual(new Set([0, 1, 2]));
    expect(order.wordOrder[order.wordOrder.length - 1]).toBe(0);
  });

  test("abutting words (no space) leave no space item", () => {
    const order = captionWordVisualOrder(
      [{ text: "你好", space: false }, { text: "世界", space: false }],
      "ltr",
    );
    expect(order.items).toEqual([{ word: 0 }, { word: 1 }]);
  });

  test("a line never starts or ends with a space", () => {
    for (const direction of ["ltr", "rtl"] as const) {
      const { items } = line(["لیے", "Extended", "Family", "اور", "2026"], direction);
      expect("space" in items[0]!).toBe(false);
      expect("space" in items[items.length - 1]!).toBe(false);
    }
  });

  test("reorderByLevels is UAX #9 L2", () => {
    expect(reorderByLevels([0, 0, 0])).toEqual([0, 1, 2]);
    expect(reorderByLevels([1, 1, 1])).toEqual([2, 1, 0]);
    // Latin (level 2) inside RTL text keeps its own order while the line reverses.
    expect(reorderByLevels([1, 1, 2, 2, 1])).toEqual([4, 2, 3, 1, 0]);
  });

  test("resolveBidiLevels follows the base direction", () => {
    expect(resolveBidiLevels("abc", "ltr")).toEqual([0, 0, 0]);
    expect(resolveBidiLevels("abc", "rtl")).toEqual([2, 2, 2]);
    expect(resolveBidiLevels("אבג", "rtl")).toEqual([1, 1, 1]);
  });
});
