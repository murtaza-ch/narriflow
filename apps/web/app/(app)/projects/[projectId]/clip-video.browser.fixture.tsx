import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
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
	const render = async (src: string) => {
		await act(async () => {
			root?.render(
				<ChakraProvider value={system}>
					<ClipVideo src={src} startSec={0} endSec={10} onMediaError={() => (errors += 1)} />
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
