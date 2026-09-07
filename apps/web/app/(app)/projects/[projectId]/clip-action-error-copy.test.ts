import { describe, expect, test } from "bun:test";
import { clipActionErrorCopy } from "./clip-action-error-copy";

describe("clipActionErrorCopy", () => {
  test("shows safe retry guidance for incomplete deletion and ignores provider text", () => {
    const copy = clipActionErrorCopy(
      {
        error: "clip_storage_delete_incomplete",
        message: "provider failed for private/project/object.mp4",
      },
      "Please try again.",
    );

    expect(copy).toBe(
      "Some clip media could not be deleted. The clip is still here, so try deleting it again.",
    );
    expect(copy).not.toContain("private/project/object.mp4");
    expect(copy).not.toContain("provider failed");
  });

  test("uses the caller fallback for a malformed response", () => {
    expect(clipActionErrorCopy(null, "Please try again.")).toBe(
      "Please try again.",
    );
  });
});
