import type { EditorDocument } from "@narriflow/validators";

export type CompositionPlanQaFixture = "invalid" | "text-fit";

type InvalidCompositionPlanResult = {
  readonly status: "invalid";
  readonly error: { readonly code: "invalid_target" };
};

export function resolveCompositionPlanQaFixture(
  value: string | string[] | undefined,
  environment: string | undefined,
): CompositionPlanQaFixture | null {
  if (environment === "production") return null;
  return value === "invalid" || value === "text-fit" ? value : null;
}

export function applyCompositionDocumentQaFixture(
  document: EditorDocument,
  fixture: CompositionPlanQaFixture | null,
): EditorDocument {
  if (fixture !== "text-fit") return document;
  return {
    ...document,
    sceneBlocks: [
      {
        schemaVersion: 1,
        id: "00000000-0000-4000-8000-000000000002",
        anchorSec: 0,
        durationSec: 3,
        content: {
          kind: "text",
          text: "The quick brown fox keeps moving. مرحبا بالعالم 新产品发布 🚀",
          fontFamily: "Arial",
          fontAsset: null,
          color: "#FFFFFF",
          backgroundColor: "#111827",
        },
        motion: { entrance: "none", exit: "none", durationSec: 0.5 },
        templateSnapshot: null,
      },
    ],
  };
}

export function applyCompositionPlanQaFixture<T>(
  result: T,
  fixture: CompositionPlanQaFixture | null,
): T | InvalidCompositionPlanResult {
  if (fixture !== "invalid") return result;
  return {
    status: "invalid",
    error: { code: "invalid_target" },
  };
}
