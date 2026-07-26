import { describe, expect, test } from "bun:test";
import { selectTranscriptExcerpt } from "./content-suite.service";

describe("selectTranscriptExcerpt", () => {
  test("returns short transcripts unchanged", () => {
    expect(selectTranscriptExcerpt("short transcript")).toBe(
      "short transcript",
    );
  });

  test("deterministically covers the head, middle, and tail", () => {
    const transcript = [
      `HEAD-${"a".repeat(45_000)}`,
      `MIDDLE-${"b".repeat(45_000)}`,
      "TAIL-",
    ].join("");

    const first = selectTranscriptExcerpt(transcript);
    const second = selectTranscriptExcerpt(transcript);

    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(48_000);
    expect(first.startsWith("HEAD-")).toBe(true);
    expect(first).toContain("MIDDLE-");
    expect(first).toContain("TAIL-");
    expect(first.endsWith("TAIL-")).toBe(true);
  });
});
