import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const browser = new Window({ url: "http://localhost:3000/projects/test/studio" });
const browserGlobalKeys = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Event",
	"MouseEvent",
	"MutationObserver",
	"ResizeObserver",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"getComputedStyle",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalBrowserGlobals = new Map(
	browserGlobalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

let GeneratedMediaPanel: typeof import("./generated-media-panel").GeneratedMediaPanel;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root | null = null;
let container: HTMLElement | null = null;

function installBrowserGlobals() {
	Object.assign(globalThis, {
		window: browser,
		document: browser.document,
		navigator: browser.navigator,
		HTMLElement: browser.HTMLElement,
		Element: browser.Element,
		Node: browser.Node,
		Event: browser.Event,
		MouseEvent: browser.MouseEvent,
		MutationObserver: browser.MutationObserver,
		ResizeObserver: browser.ResizeObserver,
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			browser.setTimeout(() => callback(browser.performance.now()), 0),
		cancelAnimationFrame: (handle: number) => browser.clearTimeout(handle),
		getComputedStyle: browser.getComputedStyle.bind(browser),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

const ids = {
	project: "00000000-0000-4000-8000-000000000001",
	clip: "00000000-0000-4000-8000-000000000002",
	job: "00000000-0000-4000-8000-000000000003",
	asset: "00000000-0000-4000-8000-000000000004",
};

function props(overrides: Record<string, unknown> = {}) {
	return {
		projectId: ids.project,
		clipId: ids.clip,
		basePlayheadSec: 3,
		baseDurationSec: 20,
		compositePlayheadSec: 6,
		compositeDurationSec: 23,
		promptSources: [{
			id: "source-old",
			label: "Selected transcript",
			origin: {
				kind: "transcript_selection" as const,
				sourceIds: [`clip:${ids.clip}:transcript:4:0`],
			},
			prompt: "Old selected words",
			derivedContext: "Old selected words",
		}],
		jobs: [{
			id: ids.job,
			kind: "image" as const,
			status: "completed" as const,
			errorCode: null,
			moderationOutcome: "passed" as const,
			assetAvailability: "available" as const,
			savedToActiveBrandProfile: false,
			asset: {
				jobId: ids.job,
				assetId: ids.asset,
				fingerprint: "a".repeat(64),
				kind: "image" as const,
				durationSec: null,
				title: "Dawn studio",
				accessUrl: "https://media.example.test/generated.png",
			},
		}],
		selectedBrollPlacementId: null,
		activeBrandProfile: null,
		usage: null,
		imageAvailable: true,
		videoAvailable: true,
		onGenerate: async () => {},
		onRefresh: async () => {},
		onCancel: async () => {},
		onInsert: async () => {},
		onSaveToBrand: async () => {},
		onDownload: () => {},
		onDelete: async () => {},
		...overrides,
	};
}

async function render(nextProps = props()) {
	container ??= browser.document.createElement("div");
	if (!container.isConnected) browser.document.body.append(container);
	root ??= createRoot(container as unknown as HTMLDivElement);
	await act(async () => {
		root?.render(
			<ChakraProvider value={system}>
				<GeneratedMediaPanel {...(nextProps as never)} />
			</ChakraProvider>,
		);
		await browser.happyDOM.waitUntilComplete();
	});
	return container;
}

function button(label: string) {
	return [...(container?.querySelectorAll("button") ?? [])].find(
		(candidate) => candidate.textContent?.includes(label),
	) as HTMLButtonElement | undefined;
}

beforeAll(async () => {
	installBrowserGlobals();
	({ GeneratedMediaPanel } = await import("./generated-media-panel"));
	({ ChakraProvider } = await import("@chakra-ui/react"));
	({ system } = await import("@narriflow/ui/theme"));
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container = null;
	browser.document.body.replaceChildren();
});

afterAll(() => {
	browser.close();
	for (const key of browserGlobalKeys) {
		const descriptor = originalBrowserGlobals.get(key);
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

describe("GeneratedMediaPanel interactions", () => {
	test("shows the actionable bound for a long transcript selection", async () => {
		await render(props({
			promptSources: [{
				id: "source-bounded",
				label: "Selected transcript · first 64 words",
				origin: {
					kind: "transcript_selection" as const,
					sourceIds: [`clip:${ids.clip}:transcript:4:0`],
				},
				prompt: "Bounded selection",
				derivedContext: "Bounded selection",
				notice: "Using the first 64 words. Narrow the transcript selection to include a later passage.",
			}],
		}));

		expect(container?.textContent).toContain(
			"Using the first 64 words. Narrow the transcript selection to include a later passage.",
		);
	});

	test("keeps kind semantics explicit and refreshes a changed selected source", async () => {
		await render();
		expect(button("Still")?.getAttribute("aria-pressed")).toBe("true");
		await act(async () => {
			button("Video")?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
		});
		expect(button("Video")?.getAttribute("aria-pressed")).toBe("true");

		await render(props({
			promptSources: [{
				id: "source-new",
				label: "Selected transcript",
				origin: {
					kind: "transcript_selection",
					sourceIds: [`clip:${ids.clip}:transcript:5:0`],
				},
				prompt: "New selected words",
				derivedContext: "New selected words",
			}],
		}));
		const prompt = container?.querySelector(
			'textarea[aria-label="Generation prompt"]',
		) as HTMLTextAreaElement | null;
		expect(prompt?.value).toBe("New selected words");
	});

	test("requires confirmation and sends the job id, never the asset id, for deletion", async () => {
		const onDelete = mock(async () => {});
		await render(props({ onDelete }));
		await act(async () => {
			container?.querySelector(
				'button[aria-label="Delete Dawn studio"]',
			)?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
		});
		expect(onDelete).toHaveBeenCalledTimes(0);
		expect(container?.textContent).toContain("Existing timeline placements stay available");
		await act(async () => {
			container?.querySelector(
				'button[aria-label="Confirm delete Dawn studio"]',
			)?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
			await browser.happyDOM.waitUntilComplete();
		});
		expect(onDelete).toHaveBeenCalledWith(ids.job);
		expect(onDelete).not.toHaveBeenCalledWith(ids.asset);
	});
});
