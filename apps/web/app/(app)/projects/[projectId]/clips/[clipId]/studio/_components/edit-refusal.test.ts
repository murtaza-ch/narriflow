import { describe, expect, test } from "bun:test";
import { refusedEditToast } from "./edit-refusal";

describe("a refused one-shot edit", () => {
  test("says why instead of reporting success", () => {
    expect(refusedEditToast({ accepted: false, reason: "read-only" }).title).toBe("Read-only here");
    for (const reason of ["conflict", "starting", "closed"] as const) {
      expect(refusedEditToast({ accepted: false, reason }).title).toBe("Your clip is unchanged");
    }
  });
});
