import { expect, test } from "bun:test";
import { classifyRenderObjectKey } from "./render-object-key";

test("render object key diagnostics use one namespace vocabulary", () => {
  expect(
    classifyRenderObjectKey(
      "projects/project/renders/clip/9x16-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4",
    ),
  ).toBe("attempt_unique_render");
  expect(
    classifyRenderObjectKey(
      "projects/project/exports/export/variant-9x16-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4",
    ),
  ).toBe("attempt_unique_export");
  expect(classifyRenderObjectKey("projects/project/source/input.mp4")).toBe(
    "other",
  );
});
