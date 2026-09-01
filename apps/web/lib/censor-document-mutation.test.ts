import { describe, expect, test } from "bun:test";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import { censorDocumentMutationError } from "./censor-document-mutation";

function documentWithCensor() {
  return editorDocumentSchema.parse({
    version: 2,
    clipStartSec: 0,
    clipEndSec: 3,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({}),
    brollUrl: null,
    deletedRanges: [],
    censorSegments: [{
      schemaVersion: 1,
      id: "50000000-0000-4000-8000-000000000001",
      sourceWordIds: ["word:one"],
      sourceStartSec: 1,
      sourceEndSec: 1.4,
      treatment: "beep",
      paddingSec: 0.06,
      beepSettings: { frequencyHz: 1_000, levelDb: -8 },
      captionMaskPolicy: null,
      suggestionFingerprint: "e".repeat(64),
      policyVersion: "auto-censor-2026-09-01.1",
      enabled: true,
    }],
  });
}

describe("censorDocumentMutationError", () => {
  test("lets a downgraded workspace disable or remove an existing censor", () => {
    const current = documentWithCensor();
    expect(censorDocumentMutationError("free", current, {
      ...current,
      censorSegments: [{ ...current.censorSegments[0]!, enabled: false }],
    })).toBeNull();
    expect(censorDocumentMutationError("free", current, {
      ...current,
      censorSegments: [],
    })).toBeNull();
  });

  test("still gates creating, enabling, or editing an enabled censor", () => {
    const current = documentWithCensor();
    const disabled = {
      ...current,
      censorSegments: [{ ...current.censorSegments[0]!, enabled: false }],
    };
    expect(censorDocumentMutationError("free", disabled, current)?.error).toBe(
      "censor_feature_unavailable",
    );
    expect(censorDocumentMutationError("free", current, {
      ...current,
      censorSegments: [{ ...current.censorSegments[0]!, paddingSec: 0.1 }],
    })?.error).toBe("censor_feature_unavailable");
  });
});
