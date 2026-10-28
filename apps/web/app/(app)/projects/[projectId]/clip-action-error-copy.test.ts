import { describe, expect, test } from "bun:test";
import { ApiError } from "@narriflow/api-client";
import { clipActionErrorCopy, failureNeedsStateRefetch } from "./clip-action-error-copy";

describe("clipActionErrorCopy", () => {
  test("shows safe retry guidance for incomplete deletion and ignores provider text", () => {
    const copy = clipActionErrorCopy(
      new ApiError({
        code: "clip_storage_delete_incomplete",
        message: "provider failed for private/project/object.mp4",
        status: 503,
      }),
      "Please try again.",
    );

    expect(copy).toBe(
      "Some clip media could not be deleted. The clip is still here, so try deleting it again.",
    );
    expect(copy).not.toContain("private/project/object.mp4");
    expect(copy).not.toContain("provider failed");
  });

  test("uses the API's own message for a code without product copy", () => {
    expect(
      clipActionErrorCopy(
        new ApiError({ code: "some_new_code", message: "Choose a valid clip.", status: 422 }),
        "Please try again.",
      ),
    ).toBe("Choose a valid clip.");
  });

  test("uses the caller fallback when no response was received", () => {
    expect(
      clipActionErrorCopy(
        new ApiError({ code: "network_error", message: "fetch failed", status: 0 }),
        "Please try again.",
      ),
    ).toBe("Please try again.");
    expect(clipActionErrorCopy(new Error("boom"), "Please try again.")).toBe("Please try again.");
    expect(clipActionErrorCopy(null, "Please try again.")).toBe("Please try again.");
  });
});

describe("failureNeedsStateRefetch", () => {
  const failure = (status: number, code = "x") => new ApiError({ code, message: "m", status });

  test("a lost response, a server fault or a conflict sends the screen back to the domain state", () => {
    expect(failureNeedsStateRefetch(failure(0, "network_error"))).toBe(true);
    expect(failureNeedsStateRefetch(failure(503))).toBe(true);
    expect(failureNeedsStateRefetch(failure(409, "stale_editor_revision"))).toBe(true);
    expect(failureNeedsStateRefetch(new Error("boom"))).toBe(true);
  });

  test("a plain refusal changed nothing", () => {
    for (const status of [400, 402, 403, 404, 422, 429]) {
      expect(failureNeedsStateRefetch(failure(status))).toBe(false);
    }
  });
});
