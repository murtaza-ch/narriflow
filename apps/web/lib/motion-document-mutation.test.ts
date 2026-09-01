import { describe, expect, test } from "bun:test";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  motionDocumentExportError,
  motionDocumentMutationError,
} from "./motion-document-mutation";
import { editorDocumentUsesMotion } from "@narriflow/validators";

function baseDocument() {
  return editorDocumentSchema.parse({
    version: 2,
    clipStartSec: 0,
    clipEndSec: 3,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({}),
    brollUrl: null,
    deletedRanges: [],
  });
}

describe("motionDocumentMutationError", () => {
  test("gates enabling or changing active motion on Free", () => {
    const current = baseDocument();
    const transitioned = {
      ...current,
      studioEdits: {
        ...current.studioEdits,
        transition: { type: "fade" as const, durationSec: 0.4 },
      },
    };

    expect(
      motionDocumentMutationError("free", current, transitioned)?.error,
    ).toBe("motion_feature_unavailable");
    expect(
      motionDocumentMutationError("creator", current, transitioned),
    ).toBeNull();
    expect(
      motionDocumentMutationError("free", transitioned, {
        ...transitioned,
        studioEdits: {
          ...transitioned.studioEdits,
          transition: { type: "wipe-left", durationSec: 0.4 },
        },
      })?.error,
    ).toBe("motion_feature_unavailable");
  });

  test("lets a downgraded workspace remove active motion", () => {
    const none = baseDocument();
    const current = {
      ...none,
      studioEdits: {
        ...none.studioEdits,
        transition: { type: "fade" as const, durationSec: 0.4 },
      },
    };

    expect(motionDocumentMutationError("free", current, none)).toBeNull();
  });

  test("gates active selected-media motion but permits disabling it", () => {
    const current = baseDocument();
    const motion = {
      schemaVersion: 1 as const,
      id: "50000000-0000-4000-8000-000000000001",
      target: { kind: "broll" as const },
      startSec: 0,
      endSec: 2,
      entrance: "pan-left" as const,
      exit: "ken-burns-out" as const,
      durationSec: 0.5,
      enabled: true,
    };
    const animated = { ...current, mediaMotions: [motion] };

    expect(
      motionDocumentMutationError("free", current, animated)?.error,
    ).toBe("motion_feature_unavailable");
    expect(
      motionDocumentMutationError("free", animated, {
        ...animated,
        mediaMotions: [{ ...motion, enabled: false }],
      }),
    ).toBeNull();
  });

  test("blocks Free export of an already-motion-enabled document", () => {
    const document = baseDocument();
    const animated = {
      ...document,
      studioEdits: {
        ...document.studioEdits,
        transition: { type: "wipe-left" as const, durationSec: 0.4 },
      },
    };

    expect(editorDocumentUsesMotion(animated)).toBe(true);
    expect(motionDocumentExportError("free", animated)).toMatchObject({
      status: 403,
      error: "motion_feature_unavailable",
    });
    expect(motionDocumentExportError("creator", animated)).toBeNull();
  });

  test("allows Free export after all motion is disabled", () => {
    const document = baseDocument();

    expect(editorDocumentUsesMotion(document)).toBe(false);
    expect(motionDocumentExportError("free", document)).toBeNull();
  });
});
