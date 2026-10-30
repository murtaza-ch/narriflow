import { describe, expect, test } from "bun:test";
import type { ClipRender } from "@prisma/client";
import { clipRenderVariantSchema } from "@narriflow/validators";
import { toClipRenderVariantSnapshot } from "./clip.service";

function render(captionDiagnostics: unknown): ClipRender {
  return {
    id: "r",
    clipId: "c",
    aspectRatio: "ratio_9_16",
    status: "completed",
    storageKey: "k",
    sizeBytes: 10n,
    durationSec: 5,
    errorCode: null,
    completedAt: new Date("2026-10-30T00:00:00Z"),
    resolution: "1080p",
    captionDiagnostics,
  } as unknown as ClipRender;
}

describe("clip render variant read model", () => {
  test("exposes what the render left out of its captions", () => {
    const variant = toClipRenderVariantSnapshot(render({ omittedCodePoints: ["U+2605"], skippedEmoji: ["\u{1FAE8}"] }));
    expect(variant.captionDiagnostics).toEqual({ omittedCodePoints: ["U+2605"], skippedEmoji: ["\u{1FAE8}"] });
    expect(clipRenderVariantSchema.parse(variant).captionDiagnostics).toEqual(variant.captionDiagnostics);
  });

  test("Indic labels beside a supplementary-plane one all reach the read model", () => {
    const labels = ["U+0985", "U+0B85", "U+0C05", "U+13000"];
    expect(toClipRenderVariantSnapshot(render({ omittedCodePoints: labels, skippedEmoji: [] })).captionDiagnostics?.omittedCodePoints).toEqual(labels);
  });

  test("a normal, empty or malformed column reads as nothing to show", () => {
    for (const value of [null, undefined, { omittedCodePoints: [], skippedEmoji: [] }, { nope: true }, "bad"]) {
      expect(toClipRenderVariantSnapshot(render(value)).captionDiagnostics).toBeNull();
    }
  });
});
