import { describe, expect, test } from "bun:test";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  applyCompositionDocumentQaFixture,
  applyCompositionPlanQaFixture,
  resolveCompositionPlanQaFixture,
} from "./composition-plan-qa-fixture";

describe("Clip Composition Plan browser fixture", () => {
  test("is available only outside production", () => {
    expect(resolveCompositionPlanQaFixture("invalid", "development")).toBe(
      "invalid",
    );
    expect(resolveCompositionPlanQaFixture("invalid", "test")).toBe("invalid");
    expect(resolveCompositionPlanQaFixture("text-fit", "development")).toBe(
      "text-fit",
    );
    expect(resolveCompositionPlanQaFixture("text-fit", "production")).toBeNull();
    expect(resolveCompositionPlanQaFixture("invalid", "production")).toBeNull();
    expect(resolveCompositionPlanQaFixture("anything-else", "development")).toBeNull();
  });

  test("adds long multilingual Scene copy to preview planning without changing the saved document", () => {
    const document = editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 0,
      clipEndSec: 6,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null,
      deletedRanges: [],
    });

    const preview = applyCompositionDocumentQaFixture(document, "text-fit");

    expect(document.sceneBlocks).toEqual([]);
    expect(preview.sceneBlocks).toEqual([
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000002",
        anchorSec: 0,
        durationSec: 3,
        content: expect.objectContaining({
          kind: "text",
          text: "The quick brown fox keeps moving. مرحبا بالعالم 新产品发布 🚀",
        }),
      }),
    ]);
  });

  test("replaces a plan result with a deterministic invalid-plan result", () => {
    const ready = {
      status: "ready" as const,
      plan: { fingerprint: "ready-plan" },
    };

    expect(applyCompositionPlanQaFixture(ready, null)).toBe(ready);
    expect(applyCompositionPlanQaFixture(ready, "invalid")).toEqual({
      status: "invalid",
      error: { code: "invalid_target" },
    });
  });
});
