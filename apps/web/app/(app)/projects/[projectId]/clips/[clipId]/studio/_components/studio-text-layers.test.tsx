import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type StudioEdits, studioEditsSchema, studioTextLayerSchema } from "@narriflow/validators";

type Setter = (update: (prev: StudioEdits) => StudioEdits, coalesceKey?: string) => void;

let fields: Record<string, unknown> = {};
mock.module("./studio-shell", () => ({ useStudio: () => fields }));

const { useTextLayerCommands, applyTitleDialogCopy } = await import("./studio-text-layers");
const { currentTextPanelTab, showTextPanelTab } = await import("./text-panel-tab");

const title = studioTextLayerSchema.parse({ id: "t", role: "title", text: "A title", startSec: 0, endSec: 5 });
const body = studioTextLayerSchema.parse({ id: "b", role: "body", text: "Body", startSec: 1, endSec: 4 });

let playhead = 2;

/** The Studio as the commands see it, recording every document change, coalesce key and coalesce end. */
function studio(selectedTextLayerId: string | null = null) {
  showTextPanelTab("presets");
  let edits: StudioEdits = { ...studioEditsSchema.parse({}), textLayers: [title, body] };
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
    playbackClock: { getSnapshot: () => playhead, subscribe: () => () => undefined },
    compositeToBaseEdited: (time: number) => time,
    baseEditedToComposite: (time: number) => time,
    // A 3 s scene inserted at 4 s (base): base [s, e) shows as up to two composite ranges around it.
    baseEditedRangeToComposite: (startSec: number, endSec: number) => {
      if (endSec <= 4) return [{ baseStartSec: startSec, baseEndSec: endSec, startSec, endSec }];
      if (startSec >= 4) return [{ baseStartSec: startSec, baseEndSec: endSec, startSec: startSec + 3, endSec: endSec + 3 }];
      return [
        { baseStartSec: startSec, baseEndSec: 4, startSec, endSec: 4 },
        { baseStartSec: 4, baseEndSec: endSec, startSec: 7, endSec: endSec + 3 },
      ];
    },
    editedTimeMap: { editedDurationSec: 30 },
    clipInfo: { clipTitle: "Clip title", title: "hook" },
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

  test("a row whose layer is not on screen seeks to its start", () => {
    const { commands, log } = studio();
    commands.select("b", { seek: true });
    expect(log).toEqual(["select:b"]);
    const later = studio();
    later.commands.select("t", { seek: false });
    expect(later.log).toEqual(["select:t"]);
  });

  test("selecting shows Settings, even for the layer already selected; a preset card keeps the cards in view", () => {
    const { commands } = studio("t");
    commands.select("t");
    expect(currentTextPanelTab()).toBe("settings");
    showTextPanelTab("presets");
    commands.applyPreset(studioTextLayerSchema.parse({ id: "x", text: "x" }).style);
    expect(currentTextPanelTab()).toBe("presets");
    commands.select("t");
    commands.remove("t");
    expect(currentTextPanelTab()).toBe("presets");
  });

  test("a chip or row in an inserted scene's gap seeks to the layer's first visible frame", () => {
    playhead = 5;
    const { commands, log } = studio();
    commands.select("t", { seek: true });
    // The title (0–5 s base) shows 0–4 and 7–8 composite: the playhead at 5 s is in the gap.
    expect(log).toEqual(["select:t", "seek:0"]);
    playhead = 7.5;
    const inside = studio();
    inside.commands.select("t", { seek: true });
    expect(inside.log).toEqual(["select:t"]);
    playhead = 2;
  });

  test("an arrow-key burst is one coalesced change", () => {
    const { commands, log, edits } = studio("t");
    commands.nudge("t", { positionX: 51, positionY: 12 });
    commands.nudge("t", { positionX: 52, positionY: 12 });
    commands.endCoalesce();
    expect(log).toEqual(["edit:text-layer-nudge-t", "edit:text-layer-nudge-t", "end"]);
    expect(edits().textLayers[0]).toMatchObject({ positionX: 52 });
  });
});

describe("Apply to all clips confirmation", () => {
  test("a project with no other clip says so and offers nothing to press", () => {
    const copy = applyTitleDialogCopy({ otherClips: 0, status: "idle" });
    expect(copy.confirm).toBeNull();
    expect(copy.title).toBe("No other clips in this project");
  });

  test("a refusal says nothing changed; a lost answer says the outcome is unknown; both offer to try again", () => {
    expect(applyTitleDialogCopy({ otherClips: 3, status: "refused" })).toMatchObject({ status: "Couldn't apply the title. No other clip was changed.", confirm: "Try again" });
    const unknown = applyTitleDialogCopy({ otherClips: null, status: "unknown" });
    expect(unknown.status).toContain("Couldn't confirm the change");
    expect(unknown.status).not.toContain("No other clip was changed");
    expect(unknown.confirm).toBe("Try again");
    expect(applyTitleDialogCopy({ otherClips: null, status: "idle" }).confirm).toBe("Apply to all clips");
  });
});
