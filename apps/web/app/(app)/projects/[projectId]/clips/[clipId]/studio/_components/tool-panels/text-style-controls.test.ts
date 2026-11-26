import { describe, expect, test } from "bun:test";
import { parseNumberDraft } from "./text-style-controls";

describe("Text style number fields", () => {
  const size = { min: 8, max: 240, decimals: 1 };
  test("a typed size keeps one decimal and stays in range", () => {
    expect(parseNumberDraft("56.5", size)).toBe(56.5);
    expect(parseNumberDraft("56.56", size)).toBe(56.6);
    expect(parseNumberDraft("56,5", size)).toBe(56.5);
    expect(parseNumberDraft("4", size)).toBe(8);
    expect(parseNumberDraft("999", size)).toBe(240);
  });

  test("what is not a number commits nothing", () => {
    expect(parseNumberDraft("", size)).toBeNull();
    expect(parseNumberDraft("  ", size)).toBeNull();
    expect(parseNumberDraft("big", size)).toBeNull();
  });

  test("line spacing stays a whole percent", () => {
    expect(parseNumberDraft("123.4", { min: 80, max: 250, decimals: 0 })).toBe(123);
  });
});
