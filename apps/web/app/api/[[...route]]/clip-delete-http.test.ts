import { describe, expect, test } from "bun:test";
import { ClipActionError } from "@narriflow/services";
import { clipDeleteHttpError } from "./clip-delete-http";

describe("Clip deletion HTTP mapping", () => {
  test("maps incomplete storage deletion to one safe retryable response", () => {
    const mapped = clipDeleteHttpError(
      new ClipActionError(
        "clip_storage_delete_incomplete",
        "provider failed for private/project/object.mp4",
      ),
    );

    expect(mapped).toEqual({
      status: 503,
      body: {
        error: "clip_storage_delete_incomplete",
        message:
          "Some clip media could not be deleted. The clip is still here, so try deleting it again.",
        retryable: true,
      },
    });
    expect(JSON.stringify(mapped)).not.toContain("private/project/object.mp4");
    expect(JSON.stringify(mapped)).not.toContain("provider failed");
  });

  test.each([
    ["clip_not_found", 404],
    ["clip_has_scheduled_posts", 409],
    ["clip_delete_failed", 400],
  ] as const)("preserves the existing %s status", (code, status) => {
    expect(clipDeleteHttpError(new ClipActionError(code, "internal detail"))).toMatchObject({
      status,
      body: { error: code },
    });
  });

  test("ignores failures owned by another adapter", () => {
    expect(clipDeleteHttpError(new Error("other"))).toBeNull();
  });
});
