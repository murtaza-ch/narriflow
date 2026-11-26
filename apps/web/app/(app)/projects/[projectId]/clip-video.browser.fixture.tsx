import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useSyncExternalStore } from "react";
import { studioEditsSchema, studioTextLayerSchema } from "@narriflow/validators";
import type { CaptionTimeSource } from "./clips/[clipId]/studio/_components/caption-block-painter";

// The painter measures with Canvas, which happy-dom lacks: the overlay test checks what the card hands
// the shared painter (the built layer, the canvas, the scale, the edited time); the painting itself
// is the Studio's, checked in a real browser on the prototype page.
const painted: { scale: number; canvas: { width: number; height: number }; timeSource: CaptionTimeSource }[] = [];
const built: { entries: unknown[]; canvas: unknown }[] = [];
mock.module("./clips/[clipId]/studio/_components/text-layer-scene", () => ({
	useTextLayerScene: (entries: unknown[], canvas: unknown) => {
		built.push({ entries, canvas });
		return { built: { scene: { pieces: [] } }, layouts: new Map() };
	},
}));
mock.module("./clips/[clipId]/studio/_components/caption-scene-painter", () => ({
	CaptionSceneLayers: (props: (typeof painted)[number]) => {
		painted.push(props);
		return null;
	},
}));
mock.module("./clips/[clipId]/studio/_components/text-layer-sample", () => ({
	useElementWidth: () => [{ current: null }, 270],
}));
import { createRoot, type Root } from "react-dom/client";

// Runs in its own process (see clip-video.test.ts): it installs DOM globals.
const browser = new Window({ url: "http://localhost:3000/projects/p1" });
let root: Root | null = null;

beforeAll(() => {
	Object.assign(globalThis, {
		window: browser,
		document: browser.document,
		navigator: browser.navigator,
		HTMLElement: browser.HTMLElement,
		Element: browser.Element,
		Node: browser.Node,
		Event: browser.Event,
		MutationObserver: browser.MutationObserver,
		getComputedStyle: browser.getComputedStyle.bind(browser),
		CSS: browser.CSS,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
});
afterAll(async () => {
	await browser.happyDOM.close();
});

async function mount() {
	const [{ ChakraProvider }, { system }, { ClipVideo }] = await Promise.all([
		import("@chakra-ui/react"),
		import("@narriflow/ui/theme"),
		import("./clip-video"),
	]);
	const container = browser.document.createElement("div");
	browser.document.body.append(container);
	root = createRoot(container as unknown as HTMLDivElement);
	let errors = 0;
	const render = async (src: string, overlay?: (clock: CaptionTimeSource) => React.ReactNode, window = { startSec: 0, endSec: 10 }) => {
		await act(async () => {
			root?.render(
				<ChakraProvider value={system}>
					<ClipVideo src={src} startSec={window.startSec} endSec={window.endSec} onMediaError={() => (errors += 1)} overlay={overlay} />
				</ChakraProvider>,
			);
		});
	};
	const video = () => container.querySelector("video") as unknown as HTMLVideoElement;
	const fire = async (type: string) => {
		await act(async () => {
			video().dispatchEvent(new browser.Event(type));
		});
	};
	return { render, video, fire, errors: () => errors };
}

test("a media failure asks for a fresh grant and switches to it at once", async () => {
	const player = await mount();
	await player.render("https://media.test/a.mp4?sig=old");
	expect(player.video().getAttribute("src")).toStartWith("https://media.test/a.mp4?sig=old");
	await player.fire("error");
	expect(player.errors()).toBe(1);
	await player.render("https://media.test/a.mp4?sig=new");
	expect(player.video().getAttribute("src")).toStartWith("https://media.test/a.mp4?sig=new");
});

test("a renewed grant waits for a playing clip to pause", async () => {
	const player = await mount();
	await player.render("https://media.test/a.mp4?sig=old");
	await player.fire("play");
	await player.render("https://media.test/a.mp4?sig=new");
	expect(player.video().getAttribute("src")).toStartWith("https://media.test/a.mp4?sig=old");
	await player.fire("pause");
	expect(player.video().getAttribute("src")).toStartWith("https://media.test/a.mp4?sig=new");
});

function ClockReadout({ clock }: { clock: CaptionTimeSource }) {
	const time = useSyncExternalStore(clock.subscribe, clock.getSnapshot);
	return <span data-testid="clock">{time}</span>;
}

test("an overlay follows the player's time through seek, playback and the end-of-clip rewind", async () => {
	const player = await mount();
	await player.render("https://media.test/a.mp4", (clock) => <ClockReadout clock={clock} />, { startSec: 4, endSec: 9 });
	const readout = () => browser.document.querySelector("[data-testid=clock]")?.textContent;
	expect(readout()).toBe("0");
	player.video().currentTime = 4;
	await player.fire("loadedmetadata");
	expect(readout()).toBe("4");
	player.video().currentTime = 6.5;
	await player.fire("seeked");
	expect(readout()).toBe("6.5");
	player.video().currentTime = 7;
	await player.fire("timeupdate");
	expect(readout()).toBe("7");
	// Reaching the out-point rewinds to the in-point: the overlay is back on the first frame.
	player.video().currentTime = 9;
	await player.fire("timeupdate");
	expect(readout()).toBe("4");
});

test("the card's title overlay hands the shared painter the layer, the format canvas, the card scale and edited time", async () => {
	const { clipTitleOverlayModel } = await import("./clip-title-overlay-model");
	const { ClipTitleOverlay } = await import("./clip-title-overlay");
	const layer = studioTextLayerSchema.parse({ id: "title", role: "title", text: "A title", startSec: 0, endSec: 5 });
	// Proxy t=0 is source 90 s; the clip is 100–130 with 105–110 cut.
	const model = clipTitleOverlayModel(
		{ startSec: 100, endSec: 130, studioEdits: studioEditsSchema.parse({ textLayers: [layer] }), deletedRanges: [{ startSec: 105, endSec: 110 }] },
		90,
	)!;
	const canvas = { width: 1080, height: 1920 };
	const player = await mount();
	await player.render("https://media.test/proxy.mp4", (clock) => <ClipTitleOverlay model={model} canvas={canvas} clock={clock} />, { startSec: 10, endSec: 40 });
	expect(built.at(-1)).toEqual({ entries: [{ layer, window: { fromMs: 0, toMs: 5000 } }], canvas });
	const paint = painted.at(-1)!;
	expect(paint.canvas).toBe(canvas);
	expect(paint.scale).toBe(270 / 1080);
	player.video().currentTime = 14;
	expect(paint.timeSource.getSnapshot()).toBe(4);
	player.video().currentTime = 22; // source 112: after the cut
	expect(paint.timeSource.getSnapshot()).toBe(7);
	// A re-render (a progress tick, a grant renewal) does not rebuild: the same entries go to the scene hook.
	const before = built.at(-1)!.entries;
	await player.render("https://media.test/proxy.mp4?sig=new", (clock) => <ClipTitleOverlay model={model} canvas={canvas} clock={clock} />, { startSec: 10, endSec: 40 });
	expect(built.at(-1)!.entries).toBe(before);
});
