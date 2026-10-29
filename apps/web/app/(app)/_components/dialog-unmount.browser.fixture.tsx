import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const browser = new Window({ url: "http://localhost:3000/" });

let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let Dialog: typeof import("@narriflow/ui/components/dialog").Dialog;
let Portal: typeof import("@narriflow/ui/components/dialog").Portal;
let useConfirm: typeof import("@narriflow/ui/components/confirm-dialog").useConfirm;
let useOpenAfterMount: typeof import("@narriflow/ui/components/use-open-after-mount").useOpenAfterMount;
let root: Root | null = null;

function installBrowserGlobals() {
	Object.assign(globalThis, {
		window: browser,
		document: browser.document,
		navigator: browser.navigator,
		HTMLElement: browser.HTMLElement,
		HTMLInputElement: browser.HTMLInputElement,
		HTMLTextAreaElement: browser.HTMLTextAreaElement,
		Element: browser.Element,
		Node: browser.Node,
		Event: browser.Event,
		MouseEvent: browser.MouseEvent,
		KeyboardEvent: browser.KeyboardEvent,
		MutationObserver: browser.MutationObserver,
		ResizeObserver: browser.ResizeObserver,
		requestAnimationFrame: (callback: FrameRequestCallback) => browser.setTimeout(() => callback(browser.performance.now()), 0),
		cancelAnimationFrame: (handle: number) => browser.clearTimeout(handle),
		getComputedStyle: browser.getComputedStyle.bind(browser),
		CSS: browser.CSS,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

/** The conditional-mount shape the Grants and Autopilot dialogs use: the Dialog mounts already open and unmounts to close. */
function ConditionalDialog({ onClose }: { onClose: () => void }) {
	const open = useOpenAfterMount(true);
	return (
		<Dialog.Root open={open} onOpenChange={(details) => !details.open && onClose()} placement="center">
			<Portal>
				<Dialog.Backdrop />
				<Dialog.Positioner>
					<Dialog.Content>
						<Dialog.Footer>
							<Dialog.ActionTrigger asChild>
								<button type="button" id="cancel">
									Cancel
								</button>
							</Dialog.ActionTrigger>
						</Dialog.Footer>
					</Dialog.Content>
				</Dialog.Positioner>
			</Portal>
		</Dialog.Root>
	);
}

function ConditionalHost() {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button type="button" id="opener" onClick={() => setOpen(true)}>
				Open
			</button>
			{open ? <ConditionalDialog onClose={() => setOpen(false)} /> : null}
		</div>
	);
}

/** The shared confirm: its first question mounts the dialog already open (clip render confirmation). */
function ConfirmHost() {
	const { confirm, dialog } = useConfirm();
	return (
		<div>
			<button type="button" id="opener" onClick={() => void confirm({ title: "Render this clip?" })}>
				Open
			</button>
			{dialog}
		</div>
	);
}

function click(id: string): Promise<void> {
	return act(async () => {
		(browser.document.getElementById(id) as unknown as HTMLElement).click();
	});
}

async function settle() {
	for (let i = 0; i < 6; i++) {
		await act(async () => {
			await new Promise((resolve) => browser.setTimeout(resolve, 30));
			await browser.happyDOM.waitUntilComplete();
		});
	}
}

async function renderHost(element: React.ReactNode) {
	const container = browser.document.createElement("div");
	browser.document.body.append(container);
	root = createRoot(container as unknown as HTMLDivElement);
	await act(async () => {
		root?.render(
			<StrictMode>
				<ChakraProvider value={system}>{element}</ChakraProvider>
			</StrictMode>,
		);
	});
	return container;
}

function expectPageUnlocked(container: Element) {
	expect(browser.document.body.style.pointerEvents).not.toBe("none");
	expect(browser.document.body.hasAttribute("data-inert")).toBe(false);
	expect(container.getAttribute("aria-hidden")).toBeNull();
}

beforeAll(async () => {
	installBrowserGlobals();
	({ ChakraProvider } = await import("@chakra-ui/react"));
	({ system } = await import("@narriflow/ui/theme"));
	({ Dialog, Portal } = await import("@narriflow/ui/components/dialog"));
	({ useConfirm } = await import("@narriflow/ui/components/confirm-dialog"));
	({ useOpenAfterMount } = await import("@narriflow/ui/components/use-open-after-mount"));
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	browser.document.body.replaceChildren();
	browser.document.body.removeAttribute("style");
	browser.document.body.removeAttribute("data-inert");
});

afterAll(() => browser.close());

describe("dialogs that mount already open (StrictMode)", () => {
	test("a conditionally mounted Dialog leaves the page clickable after it closes", async () => {
		const container = await renderHost(<ConditionalHost />);
		await click("opener");
		await settle();
		expect(browser.document.body.style.pointerEvents).toBe("none");
		await click("cancel");
		await settle();
		expect(browser.document.getElementById("cancel")).toBeNull();
		expectPageUnlocked(container);
	});

	test("the first useConfirm question unlocks the page on Cancel", async () => {
		const container = await renderHost(<ConfirmHost />);
		await click("opener");
		await settle();
		expect(browser.document.body.style.pointerEvents).toBe("none");
		const cancel = [...browser.document.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
		await act(async () => {
			(cancel as unknown as HTMLElement).click();
		});
		await settle();
		expectPageUnlocked(container);
	});
});
