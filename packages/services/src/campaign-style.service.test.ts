import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  EDITOR_DOCUMENT_VERSION,
  brandTemplateSnapshotSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";

import { applyCampaignStyleChange } from "./campaign-operation.service";

const document = editorDocumentSchema.parse({
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
});

const style = brandTemplateSnapshotSchema.parse({
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

describe("selection-scoped campaign style", () => {
  test("uses Studio caption rules while preserving clip-local layout", () => {
    const next = applyCampaignStyleChange(document, style, false);

    expect(next.captionPreset).toMatchObject({
      fontName: "Archivo",
      primaryColor: "#F8FAFC",
      highlightColor: "#5B6CFF",
      fontSize: 58,
      positionX: 42,
      positionY: 74,
    });
    expect(next.studioEdits.logo).toEqual(document.studioEdits.logo);
    expect(next.studioEdits.textLayers).toEqual(document.studioEdits.textLayers);
  });

  test("resets only logo presentation for the frozen project profile and is idempotent", () => {
    const first = applyCampaignStyleChange(document, style, true);
    const second = applyCampaignStyleChange(first, style, true);

    expect(first.studioEdits.logo).toEqual({
      enabled: true,
      position: null,
      opacity: null,
      scalePct: null,
    });
    expect(first.studioEdits.textLayers).toEqual(document.studioEdits.textLayers);
    expect(second).toBe(first);
  });
});
