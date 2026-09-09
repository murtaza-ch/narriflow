import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
let createRoot: typeof import("react-dom/client").createRoot;
import type {
	ClipSnapshot,
	SocialAccountSnapshot,
	ClipExportSnapshot,
} from "@narriflow/validators";
const browser = new Window({
	url: "http://localhost:3000/projects/00000000-0000-4000-8000-000000000001",
});
const router = { replace: mock(() => {}), refresh: mock(() => {}) };
const params = new URLSearchParams();
mock.module("next/navigation", () => ({
	useRouter: () => router,
	useSearchParams: () => params,
}));
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1);
const clips = [2, 3].map(
	(n) =>
		({
			id: id(n),
			title: `Clip ${n}`,
			hookText: `Hook ${n}`,
			editorRevision: 1,
			durationSec: 30,
			projectId,
		}) as ClipSnapshot,
);
const accounts = [4, 5].map(
	(n) =>
		({
			id: id(n),
			platform: "youtube_shorts",
			providerAccountId: `channel${n}`,
			displayName: `Channel ${n}`,
			handle: null,
			avatarUrl: null,
			status: "active",
			scopes: [],
			expiresAt: null,
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:00.000Z",
		}) as SocialAccountSnapshot,
);
const exports = clips.map(
	(c, i) =>
		({
			id: id(10 + i),
			projectId,
			clipId: c.id,
			clipTitle: c.title,
			projectTitle: "Test",
			editorRevision: 1,
			currentEditorRevision: 1,
			isOlderVersion: false,
			resolution: "1080p",
			watermark: false,
			status: "ready",
			progress: 100,
			errorCode: null,
			createdAt: "2026-09-01T00:00:00.000Z",
			completedAt: null,
			variants: [
				{
					id: id(20 + i),
					aspectRatio: "9:16",
					resolution: "1080p",
					watermark: false,
					status: "completed",
					sizeBytes: 100,
					durationSec: 30,
					errorCode: null,
					hasAsset: true,
					completedAt: null,
				},
			],
		}) as ClipExportSnapshot,
);
let Provider: typeof import("./publishing-provider").PublishingProvider;
let usePublishing: typeof import("./publishing-provider").usePublishing;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root;
let requests: Array<{ url: string; body: any }> = [];
let generate: (body: any) => Promise<Response>;
let admit: (body: any) => Promise<Response>;
function Entry() {
	const p = usePublishing();
	return (
		<>
			<button type="button" onClick={() => p.compose([clips[1]!.id])}>
				Exact clip
			</button>
			<button
				type="button"
				onClick={() => p.compose([clips[1]!.id, clips[0]!.id])}
			>
				Bulk clips
			</button>
		</>
	);
}
beforeAll(async () => {
	Object.assign(globalThis, {
		window: browser,
		document: browser.document,
		navigator: browser.navigator,
		localStorage: browser.localStorage,
		HTMLElement: browser.HTMLElement,
		HTMLInputElement: browser.HTMLInputElement,
		HTMLTextAreaElement: browser.HTMLTextAreaElement,
		HTMLSelectElement: browser.HTMLSelectElement,
		Element: browser.Element,
		Node: browser.Node,
		Event: browser.Event,
		CustomEvent: browser.CustomEvent,
		MutationObserver: browser.MutationObserver,
		ResizeObserver: browser.ResizeObserver,
		IntersectionObserver: browser.IntersectionObserver,
		getComputedStyle: browser.getComputedStyle.bind(browser),
		requestAnimationFrame: (cb: FrameRequestCallback) =>
			browser.setTimeout(() => cb(0), 0),
		cancelAnimationFrame: (n: number) => browser.clearTimeout(n),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	({ createRoot } = await import("react-dom/client"));
	({ PublishingProvider: Provider, usePublishing } = await import(
		"./publishing-provider"
	));
	({ ChakraProvider } = await import("@chakra-ui/react"));
	({ system } = await import("@narriflow/ui/theme"));
});
async function render(
	options: {
		accounts?: SocialAccountSnapshot[];
		assistedCopyEnabled?: boolean;
		revision?: number;
		inbox?: boolean;
	} = {},
) {
	generate = async (body) =>
		Response.json({
			variants: body.platforms.map((platform: string) => ({
				id: id(30),
				platform,
				caption: `Generated for ${body.clipId}`,
				title: "Generated title",
				hashtags: [],
			})),
		});
	admit = async (body) =>
		Response.json({
			status: "completed",
			items: body.items.map((item: any) => ({
				...item,
				status: "succeeded",
				socialPostId: id(40),
				errorCode: null,
				retryable: false,
			})),
			counts: { succeeded: body.items.length, failed: 0, ineligible: 0 },
		});
	globalThis.fetch = (async (url: any, init?: RequestInit) => {
		const value = String(url);
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		requests.push({ url: value, body });
		if (value.endsWith("/visual-assets")) return Response.json({ assets: [] });
		if (value.endsWith("exports/current")) return Response.json({ exports });
		if (value.endsWith("publishing-options"))
			return Response.json({
				privacyOptions: ["PUBLIC_TO_EVERYONE"],
				directEnabled: true,
				inboxEnabled: options.inbox ?? false,
				maximumDurationSec: 180,
			});
		if (value.endsWith("generations")) return generate(body);
		if (value.endsWith("/schedule")) return admit(body);
		if (value.endsWith("social-posts")) return Response.json({ posts: [] });
		if (value.endsWith("/preview"))
			return Response.json({
				slots: body.clipIds.map((clipId: string) => ({
					clipId,
					scheduledFor: "2030-09-10T09:00:00.000Z",
				})),
			});
		throw new Error(`Unmocked request ${value}`);
	}) as typeof fetch;
	const container = browser.document.createElement("div");
	browser.document.body.append(container);
	root = createRoot(container as unknown as HTMLElement);
	await act(async () =>
		root.render(
			<ChakraProvider value={system}>
				<Provider
					projectId={projectId}
					actorId={id(6)}
					workspaceId={id(7)}
					workspaceTimezone="UTC"
					clips={
						options.revision
							? clips.map((c) => ({ ...c, editorRevision: options.revision! }))
							: clips
					}
					accounts={options.accounts ?? accounts.slice(0, 1)}
					initialPosts={[]}
					assistedCopyEnabled={options.assistedCopyEnabled ?? true}
					customThumbnailsEnabled
					campaignSchedulingEnabled
					canUploadVisualAssets
					can1080pExport
					canOverrideReview
					facebookPublishingEnabled
					canPublish
				>
					<Entry />
				</Provider>
			</ChakraProvider>,
		),
	);
}
const button = (name: string) =>
	[...browser.document.querySelectorAll("button")].find(
		(b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
	)!;
async function click(name: string) {
	await act(async () => {
		button(name).click();
	});
	await flush();
}
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
}
async function edit(element: Element, value: string) {
	await act(async () => {
		const proto =
			element.tagName === "TEXTAREA"
				? browser.HTMLTextAreaElement.prototype
				: browser.HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
		element.dispatchEvent(
			new browser.Event("input", { bubbles: true }) as unknown as Event,
		);
	});
}
afterEach(async () => {
	await act(async () => root?.unmount());
	browser.document.body.replaceChildren();
	browser.localStorage.clear();
	requests = [];
});
afterAll(() => browser.close());
test("opens the exact clip, auto-selects the sole account and generates missing copy", async () => {
	await render();
	await click("Exact clip");
	expect(
		browser.document.querySelector('[role="dialog"]')?.textContent,
	).toContain("Clip 3");
	expect(
		browser.document.querySelector('[aria-label="Selected clips"]'),
	).toBeNull();
	expect((browser.document.querySelector('textarea[aria-label="Description"]') as any).value).toBe(
		`Generated for ${clips[1]!.id}`,
	);
	expect(requests.filter((r) => r.url.endsWith("generations"))).toHaveLength(1);
	expect(router.replace).not.toHaveBeenCalled();
});
test("preserves displayed bulk order in generation and explicit admission", async () => {
	await render();
	await click("Bulk clips");
	await click("Publish now");
	const submitted = requests.find((r) => r.url.endsWith("/schedule"));
	expect(submitted?.body.items.map((i: any) => i.clipId)).toEqual([
		clips[1]!.id,
		clips[0]!.id,
	]);
	expect(submitted?.body.items[0].copy.caption).toBe(
		`Generated for ${clips[1]!.id}`,
	);
	expect(submitted?.body.items[0].exportId).toBe(exports[1]!.id);
});
test("late generation does not replace text edited while it was running", async () => {
	await render();
	let complete!: (response: Response) => void;
	generate = () =>
		new Promise((resolve) => {
			complete = resolve;
		});
	await click("Exact clip");
	await edit(
		browser.document.querySelector('textarea[aria-label="Description"]') as unknown as Element,
		"My independent wording",
	);
	await act(async () =>
		complete(
			Response.json({
				variants: [
					{
						id: id(31),
						platform: "youtube_shorts",
						caption: "Late AI response",
						title: null,
						hashtags: [],
					},
				],
			}),
		),
	);
	await flush();
	expect((browser.document.querySelector('textarea[aria-label="Description"]') as any).value).toBe(
		"My independent wording",
	);
});
test("restores manual drafts after unmount, without another generation", async () => {
	await render();
	await click("Exact clip");
	await edit(
		browser.document.querySelector('textarea[aria-label="Description"]') as unknown as Element,
		"Saved browser draft",
	);
	await act(async () => root.unmount());
	requests = [];
	await render();
	await click("Exact clip");
	expect((browser.document.querySelector('textarea[aria-label="Description"]') as any).value).toBe(
		"Saved browser draft",
	);
	expect(requests.filter((r) => r.url.endsWith("generations"))).toHaveLength(0);
});
test("a lost submission response locks edits and retries the same identity", async () => {
	await render();
	await click("Exact clip");
	admit = async () => {
		throw new TypeError("Network lost");
	};
	await click("Publish now");
	await click("Check previous submission");
	const attempts = requests.filter((r) => r.url.endsWith("/schedule"));
	expect(attempts).toHaveLength(2);
	expect(attempts[0]!.body).toEqual(attempts[1]!.body);
});
test("multiple accounts require selection and do not generate unselected copy", async () => {
	await render({ accounts });
	await click("Exact clip");
	expect(requests.filter((r) => r.url.endsWith("generations"))).toHaveLength(0);
	expect(button("Publish now").disabled).toBe(true);
});
test("same-platform accounts keep independent edits and reuse generated base copy", async () => {
	await render({ accounts });
	await click("Exact clip");
	const inputs = [
		...browser.document.querySelectorAll('input[type="checkbox"]'),
	];
	await act(async () => inputs[0]!.click());
	await flush();
	await edit(
		browser.document.querySelector('textarea[aria-label="Description"]') as unknown as Element,
		"Account one wording",
	);
	await act(async () => inputs[1]!.click());
	await flush();
	const textareas = [...browser.document.querySelectorAll('textarea[aria-label="Description"]')];
	expect(textareas[0]!.value).toBe("Account one wording");
	expect(textareas[1]!.value).toBe(`Generated for ${clips[1]!.id}`);
	expect(requests.filter((r) => r.url.endsWith("generations"))).toHaveLength(1);
});
test("a partial result survives refresh and corrected admission excludes successful items", async () => {
	await render();
	await click("Bulk clips");
	admit = async (body) =>
		Response.json({
			status: "partial",
			items: body.items.map((item: any, i: number) => ({
				...item,
				status: i === 0 ? "succeeded" : "ineligible",
				socialPostId: i === 0 ? id(40) : null,
				errorCode: i === 0 ? null : "review_approval_required",
				retryable: false,
			})),
			counts: { succeeded: 1, failed: 0, ineligible: 1 },
		});
	await click("Publish now");
	expect(browser.document.body.textContent).toContain(
		"Some items need attention",
	);
	await act(async () => root.unmount());
	await render();
	await click("Bulk clips");
	expect(browser.document.body.textContent).toContain("Submitted");
	expect(browser.document.body.textContent).toContain(
		"Review approval required",
	);
	expect(button("Publish now").disabled).toBe(true);
});
test("changed editor revision preserves wording and blocks stale media", async () => {
	await render();
	await click("Exact clip");
	await edit(
		browser.document.querySelector('textarea[aria-label="Description"]') as unknown as Element,
		"Preserve this after editing",
	);
	await act(async () => root.unmount());
	await render({ revision: 2 });
	await click("Exact clip");
	expect((browser.document.querySelector('textarea[aria-label="Description"]') as any).value).toBe(
		"Preserve this after editing",
	);
	expect(browser.document.body.textContent).toContain("updated video");
	expect(button("Publish now").disabled).toBe(true);
});
test("generation failure leaves manual composition available", async () => {
	await render();
	generate = async () =>
		Response.json(
			{ message: "Description generation unavailable" },
			{ status: 503 },
		);
	await click("Exact clip");
	expect(browser.document.body.textContent).toContain(
		"Description generation unavailable",
	);
	await edit(
		browser.document.querySelector('textarea[aria-label="Description"]') as unknown as Element,
		"Manual composition",
	);
	expect(button("Publish now").disabled).toBe(false);
});
test("empty accounts state offers connection without a disabled form maze", async () => {
	await render({ accounts: [] });
	await click("Exact clip");
	expect(browser.document.body.textContent).toContain(
		"Connect a social account",
	);
	expect(
		browser.document.querySelector('a[href^="/settings/social-accounts"]'),
	).not.toBeNull();
	expect(button("Publish now").disabled).toBe(true);
});
test("regeneration makes edited replacement scope explicit", async () => {
	await render();
	await click("Exact clip");
	await edit(
		browser.document.querySelector('textarea[aria-label="Description"]') as unknown as Element,
		"Keep this edit",
	);
	await click("Regenerate");
	expect(browser.document.body.textContent).toContain(
		"Replace edited descriptions for this account’s description",
	);
	expect((browser.document.querySelector('textarea[aria-label="Description"]') as any).value).toBe(
		"Keep this edit",
	);
	await click("Keep edits");
	expect(requests.filter((r) => r.url.endsWith("generations"))).toHaveLength(1);
});

test("TikTok inbox hides publication metadata and submits only suggested copy and media", async () => {
	await render({
		accounts: [
			{
				...accounts[0]!,
				platform: "tiktok",
				scopes: ["video.publish", "video.upload"],
			},
		],
		inbox: true,
	});
	await click("Exact clip");
	const mode = [...browser.document.querySelectorAll("select")].find((s) =>
		s.querySelector('option[value="tiktok_inbox"]'),
	)!;
	await act(async () => {
		mode.value = "tiktok_inbox";
		mode.dispatchEvent(new browser.Event("change", { bubbles: true }));
	});
	await flush();
	expect(browser.document.body.textContent).not.toContain("Choose cover");
	expect(browser.document.body.textContent).not.toContain("Visibility");
	expect(
		browser.document.querySelector('[aria-label="Copy description"]'),
	).not.toBeNull();
	await click("Send to TikTok");
	const request = requests.find((r) => r.url.endsWith("/schedule"))!;
	expect(request.body.items[0].deliveryMode).toBe("tiktok_inbox");
	expect(request.body.items[0].providerSettings).toEqual({});
	expect(request.body.items[0].thumbnail).toBeNull();
	expect(request.body.items[0].copy.caption).toContain("Generated for");
});
test("single-time scheduling previews every clip before admission", async () => {
	await render();
	await click("Bulk clips");
	await click("Schedule");
	await act(async () => { (browser.document.querySelector('input[aria-label="Date"]') as any).focus(); });
	await edit(
		browser.document.querySelector('input[aria-label="Date"]') as unknown as Element,
		"09/10/2030",
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 350));
	});
	await act(async () => {
 browser.document.querySelector('input[aria-label="Date"]')?.dispatchEvent(new browser.KeyboardEvent("keydown", {key:"Enter",bubbles: true}));
 await new Promise(resolve => setTimeout(resolve, 350));
 });
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
	const preview = requests.filter((r) => r.url.endsWith("/preview")).at(-1);
	expect(preview?.body.scheduleMode).toBe("scheduled");
	expect(preview?.body.startDate).toBe("2030-09-10");
	expect(preview?.body.clipIds).toEqual([clips[1]!.id, clips[0]!.id]);
	const submit = [...browser.document.querySelectorAll("button")]
		.filter((b) => b.textContent?.trim() === "Schedule")
		.at(-1)!;
	await act(async () => submit.click());
	await flush();
	expect(
		requests.find((r) => r.url.endsWith("/schedule"))?.body.scheduleMode,
	).toBe("scheduled");
});

test("restored deleted covers are cleared without losing copy", async () => {
	await render();
	await click("Exact clip");
	await act(async () => root.unmount());
	const key = Object.keys(browser.localStorage).find((key) => {
		try {
			return !!JSON.parse(browser.localStorage.getItem(key) ?? "null")?.drafts;
		} catch {
			return false;
		}
	})!;
	const saved = JSON.parse(browser.localStorage.getItem(key)!);
	const draft = Object.values(saved.drafts)[0] as any;
	draft.thumbnail = {
		assetId: id(77),
		fingerprint: "a".repeat(64),
		source: "uploaded",
		sourceTimeMs: null,
	};
	browser.localStorage.setItem(key, JSON.stringify(saved));
	await render();
	await click("Exact clip");
	expect(browser.document.body.textContent).toContain(
		"saved cover is no longer available",
	);
	expect(browser.document.body.textContent).toContain("Default cover");
	expect((browser.document.querySelector('textarea[aria-label="Description"]') as any).value).toContain(
		"Generated for",
	);
});

test("export signature refresh keeps preview source stable until media changes or fails", async () => {
  const { PublishingPreview } = await import("./publishing-preview");
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(<PublishingPreview key="variant-one" src="https://media.example/video?signature=one" />));
  const video = container.querySelector("video")!;
  await act(async () => root.render(<PublishingPreview key="variant-one" src="https://media.example/video?signature=two" />));
  expect(container.querySelector("video")).toBe(video);
  expect(video.getAttribute("src")).toBe("https://media.example/video?signature=one");
  await act(async () => video.dispatchEvent(new browser.Event("error")));
  expect(video.getAttribute("src")).toBe("https://media.example/video?signature=two");
  await act(async () => root.render(<PublishingPreview key="variant-two" src="https://media.example/other" />));
  expect(container.querySelector("video")!.getAttribute("src")).toBe("https://media.example/other");
});
