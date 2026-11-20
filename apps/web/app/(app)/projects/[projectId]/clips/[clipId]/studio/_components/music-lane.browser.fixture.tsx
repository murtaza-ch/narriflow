import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { studioEditsSchema, type StudioEdits } from "@narriflow/validators";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

const browser = new Window({ url: "http://localhost:3000/studio" });
const PX_PER_SEC = 10;
const studio = {
  studioEdits: studioEditsSchema.parse({}),
  selectedMusicBlockId: null as string | null,
  selectMusicBlock: mock((_id: string) => {}),
  deselectMusicBlock: mock(() => {}),
  splitSelectedMusicBlock: mock(() => true),
  deleteSelectedMusicBlock: mock(() => {}),
  setStudioEdits: mock((_update: unknown) => {}),
  endCoalesce: mock(() => {}),
  seekTo: mock((_t: number) => {}),
  setActiveTool: mock((_tool: string | null) => {}),
  timelineSnapping: false,
  baseEditedToComposite: (t: number) => t,
  compositeToBaseEdited: (t: number) => t,
  playbackClock: { getSnapshot: () => 0, subscribe: () => () => {} },
};
mock.module("./studio-shell", () => ({ useStudio: () => studio }));
mock.module("./tool-panels/audio-library", () => ({
  useAudioApi: () => null,
  fetchAudioPlayback: async () => null,
}));

let MusicLane: typeof import("./music-lane").MusicLane;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let createRoot: typeof import("react-dom/client").createRoot;
let root: Root | null = null;

beforeAll(async () => {
  Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
    Event: browser.Event, MouseEvent: browser.MouseEvent, MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver, CSS: browser.CSS,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: (callback: FrameRequestCallback) => browser.setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => browser.clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  ({ createRoot } = await import("react-dom/client"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ system } = await import("@narriflow/ui/theme"));
  ({ MusicLane } = await import("./music-lane"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
  studio.studioEdits = studioEditsSchema.parse({});
  studio.selectedMusicBlockId = null;
  for (const fn of [
    studio.selectMusicBlock, studio.deselectMusicBlock, studio.setStudioEdits,
    studio.endCoalesce, studio.seekTo, studio.setActiveTool,
  ]) fn.mockReset();
});
afterAll(() => browser.happyDOM.abort());

async function mount() {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root?.render(
      <ChakraProvider value={system}>
        <MusicLane
          left={40}
          top={200}
          width={600}
          height={36}
          pxPerSec={PX_PER_SEC}
          clipDurationSec={60}
          timelineDurationSec={60}
          visibleRange={{ startSec: 0, endSec: 60 }}
          guideTop={-176}
          guideHeight={240}
        />
      </ChakraProvider>,
    );
  });
  return container;
}

function seed(blocks: Array<Record<string, unknown>>) {
  studio.studioEdits = studioEditsSchema.parse({ music: { blocks } });
}

function pointer(type: string, init: { clientX: number; button?: number; buttons?: number }) {
  const event = new browser.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

function lastEdit(): StudioEdits {
  const calls = studio.setStudioEdits.mock.calls;
  const update = calls[calls.length - 1]![0] as (edits: StudioEdits) => StudioEdits;
  return update(studio.studioEdits);
}

test("an empty lane offers Add music, which opens the Music tool", async () => {
  const container = await mount();
  const button = container.querySelector('[aria-label="Add music"]') as unknown as HTMLButtonElement;
  expect(button).not.toBeNull();
  await act(async () => { button.click(); });
  expect(studio.setActiveTool).toHaveBeenCalledWith("music");
});

test("a click selects the block and seeks to the click point", async () => {
  seed([{ id: "a", url: "https://cdn.test/a.mp3", title: "Theme", startSec: 10, endSec: 30 }]);
  const container = await mount();
  const block = container.querySelector('[aria-label^="Theme"]') as unknown as HTMLElement;
  expect(block).not.toBeNull();
  await act(async () => {
    block.dispatchEvent(pointer("pointerdown", { clientX: 150 }));
    block.dispatchEvent(pointer("pointerup", { clientX: 150 }));
  });
  expect(studio.selectMusicBlock).toHaveBeenCalledWith("a");
  expect(studio.seekTo).toHaveBeenCalledWith(15);
  expect(studio.setStudioEdits).not.toHaveBeenCalled();
});

test("dragging moves the block once, clamped, as one write", async () => {
  seed([
    { id: "a", url: "https://cdn.test/a.mp3", title: "A", startSec: 10, endSec: 20 },
    { id: "b", url: "https://cdn.test/b.mp3", title: "B", startSec: 40, endSec: 50 },
  ]);
  const container = await mount();
  const block = container.querySelector('[aria-label^="A,"]') as unknown as HTMLElement;
  await act(async () => {
    block.dispatchEvent(pointer("pointerdown", { clientX: 150 }));
    // 30 s to the right would run into B; the block lands against it instead.
    block.dispatchEvent(pointer("pointermove", { clientX: 450 }));
  });
  expect(studio.setStudioEdits).not.toHaveBeenCalled();
  expect(container.textContent).toContain("00:30.00");
  await act(async () => { block.dispatchEvent(pointer("pointerup", { clientX: 450, buttons: 0 })); });
  expect(studio.setStudioEdits).toHaveBeenCalledTimes(1);
  expect(lastEdit().music.blocks[0]).toMatchObject({ id: "a", startSec: 30, endSec: 40, sourceStartSec: 0 });
  expect(studio.endCoalesce).toHaveBeenCalled();
});

test("the left grip trims the block and moves its in-point", async () => {
  seed([{ id: "a", url: "https://cdn.test/a.mp3", title: "A", startSec: 10, endSec: 30, sourceStartSec: 5 }]);
  const container = await mount();
  const block = container.querySelector('[aria-label^="A,"]') as unknown as HTMLElement;
  const grip = block.children[block.children.length - 2] as unknown as HTMLElement;
  await act(async () => {
    grip.dispatchEvent(pointer("pointerdown", { clientX: 100 }));
    grip.dispatchEvent(pointer("pointermove", { clientX: 130 }));
    grip.dispatchEvent(pointer("pointerup", { clientX: 130, buttons: 0 }));
  });
  expect(lastEdit().music.blocks[0]).toMatchObject({ startSec: 13, endSec: 30, sourceStartSec: 8 });
});

test("right-click selects, seeks and opens the block menu", async () => {
  seed([{ id: "a", url: "https://cdn.test/a.mp3", title: "Theme", startSec: 10, endSec: 30 }]);
  const container = await mount();
  const block = container.querySelector('[aria-label^="Theme"]') as unknown as HTMLElement;
  await act(async () => {
    block.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 10 }));
  });
  expect(studio.selectMusicBlock).toHaveBeenCalledWith("a");
  expect(studio.seekTo).toHaveBeenCalledWith(20);
  const menu = browser.document.querySelector('[aria-label="Music block settings"]');
  expect(menu?.textContent).toContain("Volume");
  expect(menu?.textContent).toContain("Fade in");
  expect(menu?.textContent).toContain("Split");
  expect(menu?.textContent).toContain("Delete");
});
