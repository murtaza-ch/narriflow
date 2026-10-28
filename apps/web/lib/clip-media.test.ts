import { describe, expect, test } from "bun:test";
import { clipMediaDescriptorFromPayload, clipMediaPayloadForClip } from "./clip-media";

function mediaPayload(overrides: Record<string, unknown> = {}) {
  return {
    downloadUrl: "https://media.example.test/clip.mp4?signature=valid",
    expiresInSeconds: 3600,
    fileName: "clip-1-hook-9x16.mp4",
    ...overrides,
  };
}

describe("clip media payloads", () => {
  test("selects one clip descriptor from a project preview response", () => {
    expect(
      clipMediaPayloadForClip({ previews: { "clip-1": mediaPayload(), "clip-2": null } }, "clip-1"),
    ).toEqual(mediaPayload());
    expect(
      clipMediaPayloadForClip({ previews: { "clip-1": mediaPayload(), "clip-2": null } }, "clip-2"),
    ).toBeNull();
  });

  test("reads a preview or download grant into a descriptor", () => {
    expect(clipMediaDescriptorFromPayload(mediaPayload({ isPreviewProxy: true, previewStartSec: 4 }))).toEqual({
      downloadUrl: "https://media.example.test/clip.mp4?signature=valid",
      fileName: "clip-1-hook-9x16.mp4",
      expiresInSeconds: 3600,
      isPreviewProxy: true,
      previewStartSec: 4,
    });
  });

  test("refuses a grant that is not a plain http(s) media URL", () => {
    expect(clipMediaDescriptorFromPayload(mediaPayload({ downloadUrl: "javascript:alert(1)" }))).toBeNull();
    expect(clipMediaDescriptorFromPayload(mediaPayload({ downloadUrl: "/api/relative" }))).toBeNull();
    expect(clipMediaDescriptorFromPayload(mediaPayload({ fileName: "" }))).toBeNull();
    expect(clipMediaDescriptorFromPayload(null)).toBeNull();
  });
});
