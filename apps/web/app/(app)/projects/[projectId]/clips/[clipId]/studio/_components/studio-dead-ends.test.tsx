import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { studioEditsSchema } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";

let fields: Record<string, unknown> = {};
mock.module("./studio-shell", () => ({ useStudio: () => fields }));

const { ReadOnlyPanelNotice } = await import("./tool-sidebar");
const { MotionExportNotice } = await import("./studio-export-menu");
const { canSubmitStudioExport, studioExportMotionLocked } = await import("./studio-export-policy");
const { ScenesPanel } = await import("./tool-panels/scenes-panel");
const { TextPanel, MAX_TEXT_LAYERS } = await import("./tool-panels/text-panel");
const { MAX_VISUAL_BROLL } = await import("./tool-panels/generated-images-panel");
const { studioUpgradePrompts } = await import("./studio-upgrade");

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<ChakraProvider value={system}>{node}</ChakraProvider>);

const clock = { getSnapshot: () => 0, getServerSnapshot: () => 0, subscribe: () => () => undefined };
const noop = () => undefined;

function textLayer(index: number) {
  return {
    id: `layer-${index}`,
    text: `Layer ${index}`,
    startSec: 0,
    endSec: null,
    positionX: 50,
    positionY: 18,
    fontName: "Arial",
    fontSize: 44,
    color: "#FFFFFF",
    backgroundColor: null,
    backgroundOpacity: 0.72,
    bold: true,
    outlineColor: "#000000",
    outlineWidth: 2,
  };
}

function scene(id: string, anchorSec: number) {
  return {
    schemaVersion: 1,
    id,
    anchorSec,
    durationSec: 3,
    content: { kind: "color", color: "#1D4ED8" },
    motion: { entrance: "none", exit: "none", durationSec: 0.5 },
    templateSnapshot: null,
  };
}

describe("Studio read-only tab", () => {
  test("tool panels say why edits are refused and offer the take-over", () => {
    const markup = render(<ReadOnlyPanelNotice onTakeOver={noop} />);
    expect(markup).toContain("Read-only here");
    expect(markup).toContain("Take over");
  });
});

describe("Studio export with motion the plan lost", () => {
  const withTransition = {
    studioEdits: { transition: { type: "fade", durationSec: 0.4 } },
    sceneBlocks: [],
    mediaMotions: [],
  } as unknown as Parameters<typeof studioExportMotionLocked>[0];

  test("mirrors the export admission: motion exports only on a plan with motion", () => {
    expect(studioExportMotionLocked(withTransition, false)).toBe(true);
    expect(studioExportMotionLocked(withTransition, true)).toBe(false);
    const cut = { ...withTransition, studioEdits: { transition: { type: "none", durationSec: 0.4 } } } as typeof withTransition;
    expect(studioExportMotionLocked(cut, false)).toBe(false);
    expect(canSubmitStudioExport({ compositionPlanStatus: "ready", exportState: "idle", selectedVariantCount: 1, motionLocked: true })).toBe(false);
  });

  test("names the plan and offers both ways out", () => {
    const markup = render(<MotionExportNotice planName="Creator" onRemove={noop} onUpgrade={noop} />);
    expect(markup).toContain("needs Creator to export");
    expect(markup).toContain("Turn off motion");
    expect(markup).toContain("Upgrade");
  });
});

describe("Scenes after a downgrade", () => {
  const prompts = studioUpgradePrompts("free", { requiredTier: "creator" });

  function renderScenes() {
    fields = {
      deleteSceneBlock: noop,
      duplicateSceneBlock: noop,
      duration: 30,
      editedTimeMap: {},
      editorDocument: { transcriptSlice: [] },
      insertSceneBlock: noop,
      moveSceneBlock: noop,
      playbackClock: clock,
      replaceSceneBlock: noop,
      sceneBlocks: [scene("00000000-0000-4000-8000-000000000001", 0), scene("00000000-0000-4000-8000-000000000002", 10)],
      sceneFonts: [],
      sceneTemplates: [],
      sceneWriteCapabilities: { cards: false, images: false, videos: false, templates: false },
      seekTo: noop,
      trimSceneBlock: noop,
      updateSceneMotion: noop,
      upgradePrompts: prompts,
      visualAssets: [],
    };
    return render(<ScenesPanel />);
  }

  test("any scene can be removed on a locked plan", () => {
    const markup = renderScenes();
    const deletes = [...markup.matchAll(/<button[^>]*aria-label="Delete scene"[^>]*>/g)].map((match) => match[0]);
    expect(deletes).toHaveLength(2);
    expect(deletes.every((button) => !button.includes("disabled"))).toBe(true);
  });

  test("locked edits open the upgrade instead of greying out", () => {
    const markup = renderScenes();
    const moves = [...markup.matchAll(/<button[^>]*aria-label="Move scene to start"[^>]*>/g)].map((match) => match[0]);
    expect(moves.every((button) => !button.includes("disabled") && button.includes('aria-haspopup="dialog"'))).toBe(true);
    expect(markup).toContain("Editing scenes needs Creator");
    expect(markup).toContain("Upgrade to edit scenes");
  });
});

describe("Document caps the save would refuse", () => {
  test("panel caps match the editor schema", () => {
    const base = studioEditsSchema.parse({});
    const layers = (count: number) => Array.from({ length: count }, (_, index) => textLayer(index));
    expect(studioEditsSchema.safeParse({ ...base, textLayers: layers(MAX_TEXT_LAYERS) }).success).toBe(true);
    expect(studioEditsSchema.safeParse({ ...base, textLayers: layers(MAX_TEXT_LAYERS + 1) }).success).toBe(false);
    const placements = (count: number) => Array.from({ length: count }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      asset: { kind: "visual_asset", id: "00000000-0000-4000-8000-000000000999", fingerprint: "a".repeat(64) },
      startSec: index * 4,
      endSec: index * 4 + 4,
      fit: "cover",
    }));
    expect(studioEditsSchema.safeParse({ ...base, visualBroll: placements(MAX_VISUAL_BROLL) }).success).toBe(true);
    expect(studioEditsSchema.safeParse({ ...base, visualBroll: placements(MAX_VISUAL_BROLL + 1) }).success).toBe(false);
  });

  test("a full text layer list says why nothing more can be added", () => {
    fields = {
      studioEdits: { textLayers: Array.from({ length: MAX_TEXT_LAYERS }, (_, index) => textLayer(index)) },
      setStudioEdits: noop,
      playbackClock: clock,
      duration: 30,
      selectedTextLayerId: null,
      selectTextLayer: noop,
      deselectTextLayer: noop,
      seekTo: noop,
    };
    const markup = render(<TextPanel />);
    expect(markup).toContain(`up to ${MAX_TEXT_LAYERS} text layers`);
    expect(markup).toContain('aria-disabled="true"');
  });
});
