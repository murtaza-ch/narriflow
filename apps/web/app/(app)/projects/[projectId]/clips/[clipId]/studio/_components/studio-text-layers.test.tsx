import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type BrandTitle, DEFAULT_BRAND_TITLE, type StudioEdits, studioEditsSchema, studioTextLayerSchema } from "@narriflow/validators";

type Setter = (update: (prev: StudioEdits) => StudioEdits, coalesceKey?: string) => void;

let fields: Record<string, unknown> = {};
mock.module("./studio-shell", () => ({ useStudio: () => fields }));
let brandTitle: BrandTitle = DEFAULT_BRAND_TITLE;
mock.module("./project-brand-title", () => ({ useProjectBrandTitle: () => brandTitle }));

const { useTextLayerCommands } = await import("./studio-text-layers");

const title = studioTextLayerSchema.parse({ id: "t", role: "title", text: "A title", startSec: 0, endSec: 5 });
const body = studioTextLayerSchema.parse({ id: "b", role: "body", text: "Body", startSec: 1, endSec: 4 });

/** The Studio as the commands see it, recording every document change, coalesce key and coalesce end. */
function studio(selectedTextLayerId: string | null = null, textLayers = [title, body]) {
  let edits: StudioEdits = { ...studioEditsSchema.parse({}), textLayers };
  const log: string[] = [];
  const setStudioEdits: Setter = (update, coalesceKey) => {
    edits = update(edits);
    log.push(`edit:${coalesceKey ?? "-"}`);
  };
  fields = {
    get studioEdits() {
      return edits;
    },
    setStudioEdits,
    endCoalesce: () => log.push("end"),
    selectedTextLayerId,
    selectTextLayer: (id: string) => log.push(`select:${id}`),
    deselectTextLayer: () => log.push("deselect"),
    setActiveTool: (tool: string) => log.push(`tool:${tool}`),
    playbackClock: { getSnapshot: () => 2, subscribe: () => () => undefined },
    compositeToBaseEdited: (time: number) => time,
    baseEditedToComposite: (time: number) => time,
    editedTimeMap: { editedDurationSec: 30 },
    clipInfo: { projectId: "p", clipTitle: "Clip title", title: "hook" },
    seekTo: (time: number) => log.push(`seek:${time}`),
  };
  let commands: ReturnType<typeof useTextLayerCommands> | null = null;
  function Probe() {
    commands = useTextLayerCommands();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return { commands: commands!, log, edits: () => edits };
}

describe("Text Layer commands in the Studio", () => {
  test("a canvas gesture is one coalesced change, closed at once", () => {
    const { commands, log, edits } = studio("t");
    commands.applyGesture("t", { positionX: 40, widthPct: 70, fontSize: 60 }, "corner");
    expect(log).toEqual(["edit:text-layer-canvas-corner-t", "end"]);
    expect(edits().textLayers[0]).toMatchObject({ positionX: 40, widthPct: 70, style: { fontSize: 60 } });
  });

  test("a continuous control coalesces under its gesture; a toggle is its own step", () => {
    const { commands, log } = studio("t");
    commands.updateStyle("t", { color: "#FF0000" }, "color");
    commands.updateStyle("t", { color: "#00FF00" }, "color");
    commands.updateStyle("t", { bold: false });
    expect(log).toEqual(["edit:text-layer-style-color-t", "edit:text-layer-style-color-t", "edit:-"]);
  });

  test("deleting the selected layer returns to Text → Presets", () => {
    const { commands, log, edits } = studio("b");
    commands.remove("b");
    expect(edits().textLayers.map((layer) => layer.id)).toEqual(["t"]);
    expect(log).toEqual(["edit:-", "deselect", "tool:text"]);
  });

  test("Add a title selects the clip's title instead of adding a second one", () => {
    const { commands, log, edits } = studio();
    commands.addTitle();
    expect(edits().textLayers).toHaveLength(2);
    // The playhead (2 s) is inside the title (0–5 s): no seek.
    expect(log).toEqual(["select:t"]);
  });

  test("Add a title places, times and styles a new title from the project's brand title settings", () => {
    const style = { ...DEFAULT_BRAND_TITLE.style, color: "#FFD400", fontSize: 64 };
    brandTitle = { ...DEFAULT_BRAND_TITLE, durationSec: 10, positionY: 80, widthPct: 70, style };
    try {
      const { commands, edits } = studio(null, [body]);
      commands.addTitle();
      expect(edits().textLayers[1]).toMatchObject({ role: "title", text: "Clip title", startSec: 0, endSec: 10, positionY: 80, widthPct: 70, style });
    } finally {
      brandTitle = DEFAULT_BRAND_TITLE;
    }
  });

  test("without brand title settings (loading, failed, none) Add a title uses the built-in default", () => {
    const { commands, edits } = studio(null, [body]);
    commands.addTitle();
    expect(edits().textLayers[1]).toMatchObject({ role: "title", endSec: DEFAULT_BRAND_TITLE.durationSec, positionY: DEFAULT_BRAND_TITLE.positionY, style: DEFAULT_BRAND_TITLE.style });
  });

  test("a row whose layer is not on screen seeks to its start", () => {
    const { commands, log } = studio();
    commands.select("b", { seek: true });
    expect(log).toEqual(["select:b"]);
    const later = studio();
    later.commands.select("t", { seek: false });
    expect(later.log).toEqual(["select:t"]);
  });
});
