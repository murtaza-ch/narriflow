import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  EDITOR_DOCUMENT_VERSION,
  brandTemplateSnapshotSchema,
  editorDocumentSchema,
  studioEditsSchema,
  type BrandTemplateSnapshot,
  type EditorDocument,
} from "@narriflow/validators";

import { applyCampaignStyleChange } from "./campaign-operation.service";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";

function document(overrides: Partial<EditorDocument> = {}): EditorDocument {
  return editorDocumentSchema.parse({
    version: EDITOR_DOCUMENT_VERSION,
    clipStartSec: 0,
    clipEndSec: 20,
    captionPreset: {
      ...DEFAULT_CAPTION_PRESET,
      fontName: "Arial",
      fontSize: 58,
      positionX: 42,
      positionY: 74,
    },
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({
      logo: {
        enabled: false,
        position: "top-left",
        opacity: 40,
        scalePct: 9,
      },
      textLayers: [{ id: "keep", text: "Keep this layer" }],
    }),
    brollUrl: null,
    deletedRanges: [],
    ...overrides,
  });
}

function style(): BrandTemplateSnapshot {
  return brandTemplateSnapshotSchema.parse({
    templateId: "20000000-0000-4000-8000-000000000002",
    captionPreset: {
      ...DEFAULT_CAPTION_PRESET,
      fontName: "Archivo",
      fontSize: 36,
      position: "top",
      positionX: 50,
      positionY: 12,
      primaryColor: "#F8FAFC",
      highlightColor: "#5B6CFF",
    },
    logoStorageKey: "workspaces/demo/logo.png",
    logoPosition: "bot-right",
    logoOpacity: 80,
    logoScalePct: 15,
    primaryColor: "#F8FAFC",
    secondaryColor: "#111522",
    accentColor: "#5B6CFF",
  });
}

describe("applyCampaignStyleChange", () => {
  test("matches Studio Brand Template application and preserves clip layout choices", () => {
    const current = document();
    const next = applyCampaignStyleChange(current, style(), false);

    expect(next.captionPreset).toMatchObject({
      fontName: "Archivo",
      primaryColor: "#F8FAFC",
      highlightColor: "#5B6CFF",
      fontSize: 58,
      positionX: 42,
      positionY: 74,
    });
    expect(next.studioEdits.logo).toEqual(current.studioEdits.logo);
    expect(next.studioEdits.textLayers).toEqual(current.studioEdits.textLayers);
  });

  test("project Brand Profile application resets only logo presentation to inheritance", () => {
    const current = document();
    const next = applyCampaignStyleChange(current, style(), true);

    expect(next.studioEdits.logo).toEqual({
      enabled: true,
      position: null,
      opacity: null,
      scalePct: null,
    });
    expect(next.studioEdits.textLayers).toEqual(current.studioEdits.textLayers);
  });

  test("a profile without a style still restores inherited logo identity", () => {
    const current = document();
    const once = applyCampaignStyleChange(current, null, true);
    const twice = applyCampaignStyleChange(once, null, true);

    expect(once.captionPreset).toEqual(current.captionPreset);
    expect(once.studioEdits.logo.enabled).toBe(true);
    expect(twice).toBe(once);
  });

  test("equivalent style application is referentially unchanged", () => {
    const once = applyCampaignStyleChange(document(), style(), false);
    expect(applyCampaignStyleChange(once, style(), false)).toBe(once);
  });

  test("keeps absent optional caption coordinates JSON-persistable", () => {
    const current = document({
      captionPreset: DEFAULT_CAPTION_PRESET,
    });

    const next = applyCampaignStyleChange(current, style(), true);

    expect(Object.hasOwn(next.captionPreset, "positionX")).toBe(false);
    expect(Object.hasOwn(next.captionPreset, "positionY")).toBe(false);
    expect(() => encodeClipEditorDocumentForStorage(next, null)).not.toThrow();
  });
});
