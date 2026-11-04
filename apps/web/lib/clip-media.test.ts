import { describe, expect, test } from "bun:test";
import { clipMediaDescriptorFromPayload, clipMediaPayloadForClip, intentFor, intentIn } from "./clip-media";

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

describe("action intents", () => {
  const source = () => {
    let minted = 0;
    return { minted: () => minted, createIntent: () => { minted += 1; return { id: minted } as never; } };
  };

  test("intentIn mints once and reuses the held intent", () => {
    const ref = { current: null };
    const maker = source();
    expect(intentIn(ref, maker)).toBe(intentIn(ref, maker));
    expect(maker.minted()).toBe(1);
  });

  test("intentFor keeps one intent per row until it is dropped", () => {
    const intents = new Map();
    const maker = source();
    const first = intentFor(intents, "a", maker);
    expect(intentFor(intents, "a", maker)).toBe(first);
    expect(intentFor(intents, "b", maker)).not.toBe(first);
    intents.delete("a");
    expect(intentFor(intents, "a", maker)).not.toBe(first);
    expect(maker.minted()).toBe(3);
  });
});
