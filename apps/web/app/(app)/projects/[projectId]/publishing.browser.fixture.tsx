import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { apiErrorFromResponse, createIntent } from "@narriflow/api-client";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
// The API runtime: scoped requests go to the fixture's fetch, so each test sees the real typed client's calls.
const scope = { userId: "user_clerk", workspaceId: "00000000-0000-4000-8000-000000000007" };
const runtime = {
	transport: {
		scoped: () => ({
			baseUrl: "http://api.test",
			// Like the real transport: a non-2xx answer is a typed ApiError, never a body to parse.
			fetch: async (input: string | URL, init?: RequestInit) => {
				const response = await globalThis.fetch(input, init);
				if (!response.ok) throw await apiErrorFromResponse(response);
				return response;
			},
		}),
	},
	createIntent: <T,>() => createIntent<T>(),
};
mock.module("@/app/_components/api-provider", () => ({ useApiRuntime: () => runtime, useWorkspaceScope: () => scope }));
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
			publishingEligible: true,
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
let mergeRefreshedPosts: typeof import("./publishing-provider").mergeRefreshedPosts;
let nextTrackedPostBatch: typeof import("./publishing-provider").nextTrackedPostBatch;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let UpgradeProvider: typeof import("../../_components/upgrade").UpgradeProvider;
let root: Root;
let requests: Array<{ url: string; body: any; headers: Headers }> = [];
let generate: (body: any) => Promise<Response>;
let admit: (body: any) => Promise<Response>;
/** What the render-states read and the export commands answer; `null` means every clip's video is ready. */
let renderStates: ClipExportSnapshot[] | null = null;
let holdRenderStates: Promise<void> | null = null;
let onExportCommand: (url: string) => Response | Promise<Response> = () => Response.json({}, { status: 202 });
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
	({ PublishingProvider: Provider, usePublishing, mergeRefreshedPosts, nextTrackedPostBatch } = await import(
		"./publishing-provider"
	));
	({ ChakraProvider } = await import("@chakra-ui/react"));
	({ system } = await import("@narriflow/ui/theme"));
	({ UpgradeProvider } = await import("../../_components/upgrade"));
});
async function render(
	options: {
		clips?: ClipSnapshot[];
		accounts?: SocialAccountSnapshot[];
		assistedCopyEnabled?: boolean;
		assistedCopyUpgrade?: { tier: "creator"; headline: string };
		campaignSchedulingEnabled?: boolean;
		publishingUpgrade?: { tier: "creator"; headline: string };
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
		requests.push({ url: value, body, headers: new Headers(init?.headers) });
		if (value.endsWith("/social/proposals")) return Response.json({ proposalId: "00000000-0000-4000-8000-0000000000aa" }, { status: 201 });
		if (value.endsWith("/visual-assets")) return Response.json({ assets: [] });
		if (value.endsWith("exports/render-states")) {
			await holdRenderStates;
			return Response.json({ exports: renderStates ?? exports });
		}
		if (init?.method === "POST" && /\/exports(\/[^/]+\/retry)?$/.test(value)) return onExportCommand(value);
		if (value.endsWith("publishing-options"))
			return Response.json({
				privacyOptions: ["PUBLIC_TO_EVERYONE"],
				directEnabled: true,
				inboxEnabled: options.inbox ?? false,
				maximumDurationSec: 180,
			});
		if (value.endsWith("generations")) return generate(body);
		if (value.endsWith("/schedule")) return admit(body);
		if (value.includes("social-posts")) return Response.json({ posts: [] });
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
			<QueryClientProvider client={new QueryClient()}>
			<ChakraProvider value={system}>
				<UpgradeProvider currentTier="creator" billingMode="change_plan" canManageBilling>
				<Provider
					projectId={projectId}
					actorId={id(6)}
					workspaceId={id(7)}
					workspaceTimezone="UTC"
					clips={
						options.clips ?? (options.revision
							? clips.map((c) => ({ ...c, editorRevision: options.revision! }))
							: clips)
					}
					accounts={options.accounts ?? accounts.slice(0, 1)}
					initialPosts={[]}
					initialPostsCursor={null}
					assistedCopyEnabled={options.assistedCopyEnabled ?? true}
					assistedCopyUpgrade={options.assistedCopyUpgrade ?? null}
					customThumbnailsEnabled
					customThumbnailsUpgrade={null}
					campaignSchedulingEnabled={options.campaignSchedulingEnabled ?? true}
					canUploadVisualAssets
					can1080pExport
					canOverrideReview

					canPublish
					publishingUpgrade={options.publishingUpgrade ?? null}
				>
					<Entry />
				</Provider>
				</UpgradeProvider>
			</ChakraProvider>
			</QueryClientProvider>,
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
	renderStates = null;
	holdRenderStates = null;
	onExportCommand = () => Response.json({}, { status: 202 });
});
afterAll(() => browser.close());
test("a multi-post plan lock opens the shared dialog without submitting or losing copy", async () => {
	await render({ campaignSchedulingEnabled: false });
	await click("Bulk clips");
	const caption = browser.document.querySelector('textarea[aria-label="Description"]')!;
	await edit(caption, "Keep this publishing draft");
	await click("Upgrade");
	expect([...browser.document.querySelectorAll('[role="dialog"]')].at(-1)?.textContent).toContain("Upgrade to publish multiple posts together");
	expect(browser.document.querySelector('a[href="/settings/billing?plan=pro#plans"]')).not.toBeNull();
	expect((caption as HTMLTextAreaElement).value).toBe("Keep this publishing draft");
	expect(requests.filter((request) => request.url.endsWith("/schedule"))).toHaveLength(0);
});
test("a plan without publishing opens the shared dialog instead of the composer", async () => {
	await render({ publishingUpgrade: { tier: "creator", headline: "Upgrade to publish your clips" } });
	await click("Exact clip");
	expect([...browser.document.querySelectorAll('[role="dialog"]')].at(-1)?.textContent).toContain("Upgrade to publish your clips");
	expect(browser.document.querySelector('textarea[aria-label="Description"]')).toBeNull();
	expect(requests.filter((request) => request.url.endsWith("exports/render-states"))).toHaveLength(0);
});
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

test("proposes the draft's export and caption to the account's queue once, and says where to accept it", async () => {
	await render();
	await click("Exact clip");
	const caption = browser.document.querySelector('textarea[aria-label="Description"]')!;
	await edit(caption, "A caption for the queue");
	await click("Propose to queue");
	const proposals = requests.filter((r) => r.url.endsWith("/social/proposals"));
	expect(proposals).toHaveLength(1);
	expect(proposals[0]!.body).toMatchObject({ clipId: clips[1]!.id, exportId: exports[1]!.id, socialAccountId: accounts[0]!.id, caption: "A caption for the queue" });
	expect(proposals[0]!.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
	expect(browser.document.querySelector('[role="dialog"]')?.textContent).toContain("Accept it in the queue");
	// Proposing again from the same draft is not offered.
	expect(button("Propose to queue").hasAttribute("disabled")).toBe(true);
	expect(requests.filter((r) => r.url.endsWith("/schedule"))).toHaveLength(0);
});
test("keeps every loaded history row when a bounded live refresh displaces tracked posts", () => {
	const post = (n: number, status: "scheduled" | "posted") => ({
		id: id(1000 + n),
		projectId,
		clipId: clips[0]!.id,
		accountId: accounts[0]!.id,
		platform: "youtube_shorts",
		status,
		caption: "caption",
		deliveryMode: "direct",
		publishedVideos: [],
		scheduledFor: null,
		postedAt: null,
		externalUrl: null,
		errorCode: null,
		errorDisposition: null,
		nextAttemptAt: null,
		providerProcessingStatus: null,
		providerProcessingFailureCode: null,
		providerVisibility: null,
		metrics: null,
		accountDisplayName: null,
		accountHandle: null,
		accountStatus: "active",
		workspaceStatus: "active",
		createdAt: "2026-09-01T00:00:00.000Z",
	}) as SocialPostSnapshot;
	const history = Array.from({ length: 201 }, (_, index) => post(index, "scheduled"));
	const refreshed = [...history.slice(0, 100), post(0, "posted")];
	const merged = mergeRefreshedPosts(history, refreshed);

	expect(merged).toHaveLength(201);
	expect(merged.find((entry) => entry.id === history[0]!.id)?.status).toBe("posted");
	expect(merged.some((entry) => entry.id === history[200]!.id)).toBe(true);
});

test("rotates bounded tracked post reads before discovering new live posts", () => {
	const ids = Array.from({ length: 201 }, (_, index) => id(2000 + index));
	const first = nextTrackedPostBatch(ids, 0);
	const second = nextTrackedPostBatch(ids, first.nextOffset);
	const third = nextTrackedPostBatch(ids, second.nextOffset);
	const discovery = nextTrackedPostBatch(ids, third.nextOffset);
	expect([first.ids, second.ids, third.ids].flat()).toEqual(ids);
	expect(discovery.ids).toEqual([]);
	expect(discovery.nextOffset).toBe(0);
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
test("restores an exact pending submission after all selected clips and accounts disappear", async () => {
	await render();
	await click("Exact clip");
	admit = async () => { throw new TypeError("Response lost after acceptance"); };
	await click("Publish now");
	const first = requests.find((request) => request.url.endsWith("/schedule"))!;
	await act(async () => root.unmount());
	await render({ clips: [], accounts: [], assistedCopyEnabled: false });
	await click("Exact clip");
	expect(button("Check previous submission").disabled).toBe(false);
	await click("Check previous submission");
	const attempts = requests.filter((request) => request.url.endsWith("/schedule"));
	expect(attempts).toHaveLength(2);
	expect(attempts[1]!.body).toEqual(first.body);
});
test("an incomplete terminal reply keeps the complete pending identity available for replay", async () => {
	await render();
	await click("Bulk clips");
	admit = async (body) => Response.json({
		status: "completed",
		items: [{ ...body.items[0], status: "succeeded", socialPostId: id(40), errorCode: null, retryable: false }],
		counts: { succeeded: 1, failed: 0, ineligible: 0 },
	});
	await click("Publish now");
	expect(button("Check previous submission").disabled).toBe(false);
	await click("Check previous submission");
	const attempts = requests.filter((request) => request.url.endsWith("/schedule"));
	expect(attempts).toHaveLength(2);
	expect(attempts[0]!.body.items).toHaveLength(2);
	expect(attempts[1]!.body).toEqual(attempts[0]!.body);
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
	const label = [...browser.document.querySelectorAll("label")].find(
		(element) => element.textContent?.trim() === "Review approval required",
	)!;
	await edit(browser.document.getElementById(label.htmlFor)!, "Approved for the architecture test");
	await click("Publish now");
	const attempts = requests.filter((request) => request.url.endsWith("/schedule"));
	expect(attempts).toHaveLength(2);
	expect(attempts[1]!.body.idempotencyKey).not.toBe(attempts[0]!.body.idempotencyKey);
	expect(attempts[1]!.body.items.map((item: { clipId: string }) => item.clipId)).toEqual([
		attempts[0]!.body.items[1].clipId,
	]);
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
			{ error: "assisted_copy_unavailable", message: "Description generation unavailable", requestId: "req_test" },
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
test("a plan without assisted copy keeps manual writing and shows a locked control that sends nothing", async () => {
	await render({ assistedCopyEnabled: false, assistedCopyUpgrade: { tier: "creator", headline: "Upgrade to write post descriptions with AI" } });
	await click("Exact clip");
	expect(requests.filter((r) => r.url.endsWith("generations"))).toHaveLength(0);
	await click("Description assistance(needs Creator)");
	expect(requests.filter((r) => r.url.endsWith("generations"))).toHaveLength(0);
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

function exportOf(clipIndex: number, status: ClipExportSnapshot["status"]): ClipExportSnapshot {
	const finished = status === "ready";
	return {
		...exports[clipIndex]!,
		id: id(50 + clipIndex),
		status,
		variants: exports[clipIndex]!.variants.map((variant) => ({
			...variant,
			hasAsset: finished,
			status: finished ? "completed" : status === "failed" ? "failed" : status === "rendering" ? "rendering" : "pending",
		})),
	};
}
const railCard = (clipIndex: number) =>
	[...browser.document.querySelectorAll('nav[aria-label="Selected clips"] button')].find((card) =>
		card.textContent?.includes(clips[clipIndex]!.title ?? ""),
	)!;
const rendersPolled = () => requests.filter((request) => request.url.endsWith("exports/render-states")).length;

test("each rail card shows its own clip's render state, apart from review, with a selection summary", async () => {
	renderStates = [exportOf(0, "rendering"), exportOf(1, "failed")];
	await render();
	await click("Bulk clips");
	expect(railCard(0).textContent).toContain("Rendering");
	expect(railCard(0).textContent).not.toContain("No video");
	expect(railCard(1).textContent).toContain("Failed");
	expect(railCard(1).textContent).not.toContain("Rendering");
	expect(browser.document.body.textContent).toContain("1 of 2 videos rendering · 1 failed");
});

test("Prepare video shows Queued on the clip that asked and cannot be pressed again", async () => {
	renderStates = [];
	onExportCommand = () => {
		renderStates = [exportOf(1, "queued")];
		return Response.json({ export: exportOf(1, "queued"), reused: false }, { status: 202 });
	};
	await render();
	await click("Exact clip");
	expect(browser.document.body.textContent).toContain("No video");
	await click("Prepare video");
	expect(button("Queued").disabled).toBe(true);
	expect(button("Prepare video")).toBeUndefined();
	expect(browser.document.body.textContent).not.toMatch(/\d+%/);
	const commands = requests.filter((request) => request.url.endsWith(`/clips/${clips[1]!.id}/exports`));
	expect(commands).toHaveLength(1);
	expect(commands[0]!.body).toMatchObject({ expectedRevision: 1, aspectRatios: ["9:16"], resolution: "1080p" });
});

test("two presses before the button disables send one request", async () => {
	renderStates = [];
	onExportCommand = () => {
		renderStates = [exportOf(1, "queued")];
		return Response.json({ export: exportOf(1, "queued"), reused: false }, { status: 202 });
	};
	await render();
	await click("Exact clip");
	await act(async () => {
		const prepare = button("Prepare video");
		prepare.click();
		prepare.click();
	});
	await flush();
	expect(requests.filter((request) => request.url.endsWith(`/clips/${clips[1]!.id}/exports`))).toHaveLength(1);
});

test("a pending request belongs to its own clip, so another clip can still be prepared", async () => {
	renderStates = [];
	let answer: (response: Response) => void = () => {};
	onExportCommand = () => new Promise<Response>((resolve) => { answer = resolve; });
	await render();
	await click("Bulk clips");
	await click("Prepare video");
	expect(button("Queued").disabled).toBe(true);
	await act(async () => (railCard(0) as HTMLElement).click());
	await flush();
	expect(button("Prepare video").disabled).toBe(false);
	await act(async () => answer(Response.json({ export: exportOf(1, "queued"), reused: false }, { status: 202 })));
	await flush();
});

test("a failed render offers Retry video, which requeues that export and never creates one", async () => {
	renderStates = [exportOf(1, "failed")];
	onExportCommand = () => {
		renderStates = [exportOf(1, "queued")];
		return Response.json(exportOf(1, "queued"), { status: 202 });
	};
	await render();
	await click("Exact clip");
	expect(browser.document.body.textContent).toContain("Failed");
	await click("Retry video");
	expect(requests.filter((request) => request.url.endsWith(`/clips/${clips[1]!.id}/exports/${exportOf(1, "failed").id}/retry`))).toHaveLength(1);
	expect(requests.filter((request) => request.url.endsWith(`/clips/${clips[1]!.id}/exports`))).toHaveLength(0);
	expect(button("Queued").disabled).toBe(true);
});

test("a finished render appears without a reload", async () => {
	renderStates = [exportOf(1, "rendering")];
	await render();
	await click("Exact clip");
	expect(button("Rendering").disabled).toBe(true);
	const polled = rendersPolled();
	renderStates = [exportOf(1, "ready")];
	// TanStack read `window` at import, before this fixture installs it, so it takes this process for a server and keeps
	// no interval timer. A focus refetch runs the same read; `exportQueries.renderStates` pins the cadence in its own test.
	await act(async () => {
		focusManager.setFocused(false);
		focusManager.setFocused(true);
	});
	await flush();
	focusManager.setFocused(undefined);
	expect(rendersPolled()).toBeGreaterThan(polled);
	expect(browser.document.body.textContent).toContain("Video ready");
	expect(button("Rendering")).toBeUndefined();
	expect(button("Prepare video")).toBeUndefined();
});

test("a clip reads as checking, never as having no video, until the first read answers", async () => {
	let answer: () => void = () => {};
	renderStates = [exportOf(0, "ready"), exportOf(1, "ready")];
	holdRenderStates = new Promise<void>((resolve) => { answer = resolve; });
	await render();
	await click("Bulk clips");
	expect(railCard(1).textContent).toContain("Checking video");
	expect(browser.document.body.textContent).not.toContain("No video");
	expect(button("Prepare video")).toBeUndefined();
	await act(async () => answer());
	await flush();
	expect(railCard(1).textContent).toContain("Video ready");
	expect(browser.document.body.textContent).toContain("2 of 2 videos ready");
});

test("a finished video reads as ready with no account chosen", async () => {
	await render({ accounts: accounts.slice(0, 2) });
	await click("Exact clip");
	expect(browser.document.body.textContent).toContain("Video ready");
	expect(button("Prepare video")).toBeUndefined();
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
