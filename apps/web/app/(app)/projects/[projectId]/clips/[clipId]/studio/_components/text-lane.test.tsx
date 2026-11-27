import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { studioTextLayerSchema } from "@narriflow/validators";

const noop = () => undefined;
mock.module("./studio-shell", () => ({
  useStudio: () => ({
    setStudioEdits: noop,
    endCoalesce: noop,
    selectTextLayer: noop,
    seekTo: noop,
    playbackClock: { getSnapshot: () => 0, subscribe: () => noop },
    baseEditedRangeToComposite: (startSec: number, endSec: number) => [{ baseStartSec: startSec, baseEndSec: endSec, startSec, endSec }],
  }),
}));

const { TextLayerChip } = await import("./timeline");
const { textChipRows } = await import("./text-layer-commands");
const { PREVIEW_Z } = await import("./preview-stacking");

describe("Text lane", () => {
  test("a duplicate over its original sits on the next row, both reachable; chips are tab stops", () => {
    const layers = [
      studioTextLayerSchema.parse({ id: "original", role: "title", text: "Original", startSec: 0, endSec: 5 }),
      studioTextLayerSchema.parse({ id: "copy", text: "Copy", startSec: 0, endSec: 5 }),
      studioTextLayerSchema.parse({ id: "later", text: "Later", startSec: 6, endSec: 8 }),
    ];
    const { rows } = textChipRows(layers, 30);
    const markup = renderToStaticMarkup(
      <ChakraProvider value={system}>
        {layers.map((layer) => (
          <TextLayerChip
            key={layer.id}
            id={layer.id}
            row={rows.get(layer.id) ?? 0}
            role={layer.role}
            text={layer.text}
            startSec={layer.startSec}
            endSec={layer.endSec ?? null}
            isSelected={false}
            pxPerSec={10}
            duration={30}
            baseEditedToComposite={(time) => time}
            compositeToBaseEdited={(time) => time}
          />
        ))}
      </ChakraProvider>,
    );
    const chip = (id: string) => markup.match(new RegExp(`<div[^>]*data-text-chip="${id}"[^>]*>`))?.[0] ?? "";
    expect(chip("original")).toContain('data-row="0"');
    expect(chip("original")).toContain("top:0px");
    expect(chip("copy")).toContain('data-row="1"');
    // One row is 26 px with a 3 px gap.
    expect(chip("copy")).toContain("top:29px");
    expect(chip("later")).toContain('data-row="0"');
    for (const id of ["original", "copy", "later"]) {
      expect(chip(id)).toContain('tabindex="0"');
      expect(chip(id)).toContain('role="button"');
    }
  });
});

describe("Preview stacking", () => {
  test("canvas objects stack in the composition plan's order; the selected text frame is above everything drawn", () => {
    // The plan: B-roll 20 < inserted scene 25 < text 30 < captions 40 < logo 50 < transition 60 < output treatment 70.
    const order = [PREVIEW_Z.imageBroll, PREVIEW_Z.insertedScene, PREVIEW_Z.text, PREVIEW_Z.caption, PREVIEW_Z.logo, PREVIEW_Z.transition, PREVIEW_Z.watermark];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(PREVIEW_Z.videoBroll).toBeLessThan(PREVIEW_Z.text);
    expect(PREVIEW_Z.textFrame).toBeGreaterThan(PREVIEW_Z.captionFrame);
    expect(PREVIEW_Z.textFrame).toBeGreaterThan(PREVIEW_Z.watermark);
    expect(PREVIEW_Z.textFrame).toBeLessThan(PREVIEW_Z.status);
  });
});

describe("floating text toolbar stacking", () => {
  test("sits above the Studio's fixed shell and under its dialogs", async () => {
    const { TEXT_TOOLBAR_Z } = await import("./text-layer-canvas");
    const layout = await Bun.file(new URL("../layout.tsx", import.meta.url)).text();
    const shell = Number(/zIndex=\{(\d+)\}/.exec(layout)?.[1]);
    expect(shell).toBeGreaterThan(0);
    expect(TEXT_TOOLBAR_Z).toBeGreaterThan(shell);
    expect(TEXT_TOOLBAR_Z).toBeLessThan(300);
  });
});
