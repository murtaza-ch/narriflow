import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClipSnapshot, SocialAccountSnapshot } from "@narriflow/validators";

import { CAMPAIGN_SELECTION_STORAGE_KEY } from "./campaign-selection";

mock.module("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const projectId = "40000000-0000-4000-8000-000000000001";
const clipId = "40000000-0000-4000-8000-000000000002";
const exportId = "40000000-0000-4000-8000-000000000003";
const variantId = "40000000-0000-4000-8000-000000000004";
const draftId = "40000000-0000-4000-8000-000000000005";
const jobId = "40000000-0000-4000-8000-000000000006";
const assetId = "40000000-0000-4000-8000-000000000007";
const accountId = "40000000-0000-4000-8000-000000000008";
const clipIdB = "40000000-0000-4000-8000-000000000011";
const exportIdB = "40000000-0000-4000-8000-000000000012";
const variantIdB = "40000000-0000-4000-8000-000000000013";
const draftIdB = "40000000-0000-4000-8000-000000000014";
const accountIdB = "40000000-0000-4000-8000-000000000021";

const browser = new Window({ url: `http://localhost:3000/projects/${projectId}?tab=publish` });
const originalFetch = globalThis.fetch;
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
	browserGlobalKeys.map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);

let PublishingPreparationPanel: typeof import("./publishing-preparation-panel").PublishingPreparationPanel;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root | null = null;

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

function draft(
  confirmed = false,
  target: { clipId: string; draftId: string } = { clipId, draftId },
) {
  return {
    id: target.draftId,
    clipId: target.clipId,
    platform: "tiktok",
    sourceDraftId: null,
    status: "completed",
    revision: confirmed ? 2 : 1,
    content: {
      caption: "Hydrated approved caption",
      hashtags: ["launch"],
      title: "Hydrated title",
    },
    confirmed,
    moderationOutcome: "accepted",
    modelAlias: "configured-copy-alias",
    promptVersion: "assisted-copy-v1",
    guidanceSkipped: false,
    errorCode: null,
    replayed: false,
  } as const;
}

function completedThumbnailView() {
  return {
    id: jobId,
    status: "completed",
    attempts: 1,
    platform: "tiktok",
    exportVariantId: variantId,
    sourceTimeMs: 1_000,
    errorCode: null,
    asset: {
      id: assetId,
      workspaceId: projectId,
      createdByUserId: "40000000-0000-4000-8000-000000000010",
      title: "Campaign clip thumbnail",
      kind: "image",
      contentType: "image/jpeg",
      sizeBytes: 1_024,
      width: 1_080,
      height: 1_920,
      fingerprint: "a".repeat(64),
      provenance: "extracted",
      sourceExportVariantId: variantId,
      sourceTimeMs: 1_000,
      createdAt: "2026-08-31T12:00:00.000Z",
    },
    replayed: false,
  } as const;
}

async function renderPanel(options: {
  accounts?: SocialAccountSnapshot[];
  clips?: ClipSnapshot[];
  selectedClipIds?: string[];
  assistedCopyEnabled?: boolean;
  thumbnailExtractionEnabled?: boolean;
} = {}) {
  const renderedClips = options.clips ?? [
    {
      id: clipId,
      projectId,
      editorRevision: 3,
      index: 0,
      title: "Campaign clip",
    } as never,
  ];
  browser.sessionStorage.setItem(
    CAMPAIGN_SELECTION_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      projectId,
      clipIds: options.selectedClipIds ?? renderedClips.map((clip) => clip.id),
    }),
  );
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root?.render(
      <ChakraProvider value={system}>
        <PublishingPreparationPanel
          projectId={projectId}
          clips={renderedClips}
          accounts={options.accounts ?? []}
          workspaceTimezone="UTC"
          assistedCopyEnabled={options.assistedCopyEnabled ?? true}
          thumbnailExtractionEnabled={options.thumbnailExtractionEnabled ?? true}
          bulkSchedulingEnabled
        />
      </ChakraProvider>,
    );
    await browser.happyDOM.waitUntilComplete();
  });
  return container;
}

beforeAll(async () => {
  installBrowserGlobals();
  ({ PublishingPreparationPanel } = await import("./publishing-preparation-panel"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ system } = await import("@narriflow/ui/theme"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
  browser.sessionStorage.clear();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
	browser.close();
	for (const key of browserGlobalKeys) {
		const descriptor = originalBrowserGlobals.get(key);
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

describe("PublishingPreparationPanel", () => {
	test("retains an assisted-copy intent and its form after a malformed success response", async () => {
		const idempotencyKeys: string[] = [];
		globalThis.fetch = mock(async (request, init) => {
			const url = String(request);
			if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
				return Response.json({ drafts: [draft()] });
			}
			if (url === `/api/projects/${projectId}/review-rounds`) {
				return Response.json({
					candidates: [{
						id: exportId,
						clipId,
						editorRevision: 3,
						variants: [{
							id: variantId,
							aspectRatio: "ratio_9_16",
							resolution: "1080p",
							durationSec: 30,
							status: "completed",
						}],
					}],
				});
			}
			if (url === "/api/visual-assets") return Response.json({ assets: [] });
			if (
				url === `/api/projects/${projectId}/assisted-copy` &&
				init?.method === "POST"
			) {
				const body = JSON.parse(String(init.body)) as { idempotencyKey: string };
				idempotencyKeys.push(body.idempotencyKey);
				return Response.json({
					...draft(),
					id: exportId,
					clipId: projectId,
					sourceDraftId: draftId,
					content: {
						caption: "Malformed success",
						hashtags: [],
						title: null,
					},
				});
			}
			throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;

		const container = await renderPanel();
		const regenerate = [...container.querySelectorAll("button")].find((entry) =>
			entry.textContent?.includes("Regenerate"),
		) as HTMLButtonElement;
		expect(container.textContent).toContain("1 exact export ready");
		expect(regenerate.disabled).toBe(false);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			await act(async () => {
				regenerate.click();
				await browser.happyDOM.waitUntilComplete();
			});
		}

		expect(idempotencyKeys).toHaveLength(2);
		expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
		expect(
			(container.querySelector(
				'[aria-label="Campaign clip caption"]',
			) as HTMLTextAreaElement).value,
		).toBe("Hydrated approved caption");
		expect(container.textContent).toContain(
			"Copy generation response was incomplete",
		);
	});

	test("retains a bulk-schedule intent when a successful response is malformed", async () => {
		const requests: Array<{
			idempotencyKey: string;
			items: Array<{ occurrenceIndex?: number }>;
		}> = [];
		globalThis.fetch = mock(async (request, init) => {
			const url = String(request);
			if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
				return Response.json({ drafts: [draft(true)] });
			}
			if (url === `/api/projects/${projectId}/review-rounds`) {
				return Response.json({
					candidates: [{
						id: exportId,
						clipId,
						editorRevision: 3,
						variants: [{
							id: variantId,
							aspectRatio: "ratio_9_16",
							resolution: "1080p",
							durationSec: 30,
							status: "completed",
						}],
					}],
				});
			}
			if (url === "/api/visual-assets") return Response.json({ assets: [] });
			if (url.includes("/thumbnail-extractions?") && !init?.method) {
				return Response.json({ jobs: [] });
			}
			if (url === `/api/projects/${projectId}/bulk-schedules`) {
				requests.push(JSON.parse(String(init?.body)));
				return Response.json({
					operationId: "40000000-0000-4000-8000-000000000009",
					status: "failed",
					counts: { scheduled: 0, failed: 1 },
					items: [{
						itemKey: clipId,
						clipId,
						accountId: projectId,
						status: "failed",
						postId: null,
						scheduledFor: "2026-09-01T09:00:00.000Z",
						errorCode: "provider_rate_limited",
					}],
					replayed: false,
				});
			}
			throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;

		const container = await renderPanel({
			accounts: [
				{
					id: accountId,
					platform: "tiktok",
					status: "active",
					displayName: "Primary account",
				} as SocialAccountSnapshot,
				{
					id: accountIdB,
					platform: "tiktok",
					status: "active",
					displayName: "Backup account",
				} as SocialAccountSnapshot,
			],
			thumbnailExtractionEnabled: false,
		});
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await act(async () => {
				[...container.querySelectorAll("button")]
					.find((entry) => entry.textContent?.includes("Schedule 1"))
					?.click();
				await browser.happyDOM.waitUntilComplete();
			});
		}

		expect(requests).toHaveLength(2);
		expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);
		expect(requests[0]?.items).toEqual([
			expect.objectContaining({ occurrenceIndex: 0 }),
		]);
		expect(container.textContent).toContain(
			"Campaign scheduling response was incomplete",
		);
	});

	test("retries a failed second item at its original occurrence", async () => {
		const requests: Array<{
			idempotencyKey: string;
			items: Array<{ itemKey: string; occurrenceIndex: number }>;
		}> = [];
		globalThis.fetch = mock(async (request, init) => {
			const url = String(request);
			if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
				return Response.json({
					drafts: [
						draft(true),
						draft(true, { clipId: clipIdB, draftId: draftIdB }),
					],
				});
			}
			if (url === `/api/projects/${projectId}/review-rounds`) {
				return Response.json({
					candidates: [
						{
							id: exportId,
							clipId,
							editorRevision: 3,
							variants: [{
								id: variantId,
								aspectRatio: "ratio_9_16",
								resolution: "1080p",
								durationSec: 30,
								status: "completed",
							}],
						},
						{
							id: exportIdB,
							clipId: clipIdB,
							editorRevision: 4,
							variants: [{
								id: variantIdB,
								aspectRatio: "ratio_9_16",
								resolution: "1080p",
								durationSec: 30,
								status: "completed",
							}],
						},
					],
				});
			}
			if (url === "/api/visual-assets") return Response.json({ assets: [] });
			if (url === `/api/projects/${projectId}/bulk-schedules`) {
				requests.push(JSON.parse(String(init?.body)));
				if (requests.length === 1) {
					return Response.json({
						operationId: "40000000-0000-4000-8000-000000000015",
						status: "partial",
						counts: { scheduled: 1, failed: 1 },
						items: [
							{
								itemKey: clipId,
								clipId,
								accountId,
								status: "scheduled",
								postId: "40000000-0000-4000-8000-000000000016",
								scheduledFor: "2026-09-01T09:00:00.000Z",
								errorCode: null,
							},
							{
								itemKey: clipIdB,
								clipId: clipIdB,
								accountId,
								status: "failed",
								postId: null,
								scheduledFor: "2026-09-01T11:00:00.000Z",
								errorCode: "provider_rate_limited",
							},
						],
						replayed: false,
					});
				}
				return Response.json({
					operationId: "40000000-0000-4000-8000-000000000017",
					status: "completed",
					counts: { scheduled: 1, failed: 0 },
					items: [{
						itemKey: clipIdB,
						clipId: clipIdB,
						accountId,
						status: "scheduled",
						postId: "40000000-0000-4000-8000-000000000018",
						scheduledFor: "2026-09-01T11:00:00.000Z",
						errorCode: null,
					}],
					replayed: false,
				});
			}
			throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;

		const container = await renderPanel({
			accounts: [{
				id: accountId,
				platform: "tiktok",
				status: "active",
			} as SocialAccountSnapshot],
			clips: [
				{
					id: clipId,
					projectId,
					editorRevision: 3,
					index: 0,
					title: "Campaign clip",
				} as never,
				{
					id: clipIdB,
					projectId,
					editorRevision: 4,
					index: 1,
					title: "Second campaign clip",
				} as never,
			],
			thumbnailExtractionEnabled: false,
		});
		await act(async () => {
			[...container.querySelectorAll("button")]
				.find((entry) => entry.textContent?.includes("Schedule 2"))
				?.click();
			await browser.happyDOM.waitUntilComplete();
		});
		expect(container.textContent).toContain("Retry 1 failed");

		await act(async () => {
			[...container.querySelectorAll("button")]
				.find((entry) => entry.textContent?.includes("Retry 1 failed"))
				?.click();
			await browser.happyDOM.waitUntilComplete();
		});

		expect(requests[0]?.items).toEqual([
			expect.objectContaining({ itemKey: clipId, occurrenceIndex: 0 }),
			expect.objectContaining({ itemKey: clipIdB, occurrenceIndex: 1 }),
		]);
		expect(requests[1]?.items).toEqual([
			expect.objectContaining({ itemKey: clipIdB, occurrenceIndex: 1 }),
		]);
	});

	test("does not apply a late bulk response to changed posting settings", async () => {
		let resolveSchedule: ((response: Response) => void) | null = null;
		globalThis.fetch = mock(async (request, init) => {
			const url = String(request);
			if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
				return Response.json({ drafts: [draft(true)] });
			}
			if (url === `/api/projects/${projectId}/review-rounds`) {
				return Response.json({
					candidates: [{
						id: exportId,
						clipId,
						editorRevision: 3,
						variants: [{
							id: variantId,
							aspectRatio: "ratio_9_16",
							resolution: "1080p",
							durationSec: 30,
							status: "completed",
						}],
					}],
				});
			}
			if (url === "/api/visual-assets") return Response.json({ assets: [] });
			if (url.includes("/thumbnail-extractions?") && !init?.method) {
				return Response.json({ jobs: [] });
			}
			if (url === `/api/projects/${projectId}/bulk-schedules`) {
				return await new Promise<Response>((resolve) => {
					resolveSchedule = resolve;
				});
			}
			throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;

		const container = await renderPanel({
			accounts: [
				{
					id: accountId,
					platform: "tiktok",
					status: "active",
					displayName: "Primary account",
				} as SocialAccountSnapshot,
				{
					id: accountIdB,
					platform: "tiktok",
					status: "active",
					displayName: "Backup account",
				} as SocialAccountSnapshot,
			],
			thumbnailExtractionEnabled: false,
		});
		await act(async () => {
			[...container.querySelectorAll("button")]
				.find((entry) => entry.textContent?.includes("Schedule 1"))
				?.click();
			await Promise.resolve();
		});

		const account = container.querySelector(
			'[aria-label="Campaign account"]',
		) as HTMLElement;
		await act(async () => {
			account.click();
			await browser.happyDOM.waitUntilComplete();
		});
		const backup = [...browser.document.querySelectorAll('[role="option"]')].find(
			(option) => option.textContent?.includes("Backup account"),
		) as HTMLElement;
		await act(async () => {
			backup.click();
			await browser.happyDOM.waitUntilComplete();
		});
		resolveSchedule?.(Response.json({
			operationId: "40000000-0000-4000-8000-000000000019",
			status: "completed",
			counts: { scheduled: 1, failed: 0 },
			items: [{
				itemKey: clipId,
				clipId,
				accountId,
				status: "scheduled",
				postId: "40000000-0000-4000-8000-000000000020",
				scheduledFor: "2026-09-01T09:00:00.000Z",
				errorCode: null,
			}],
			replayed: false,
		}));
		await act(async () => {
			await browser.happyDOM.waitUntilComplete();
		});

		expect(container.textContent).toContain(
			"Campaign scheduling completed for earlier settings",
		);
		expect(container.textContent).not.toContain("1 scheduled · 0 failed");
		expect(
			browser.sessionStorage.getItem(
				`narriflow:bulk-schedule-intent:v1:${projectId}`,
			),
		).not.toBeNull();
	});

	test("locks conflicting thumbnail controls while one exact-frame request owns the clip", async () => {
		const requestResolvers: Array<(response: Response) => void> = [];
		let requestCount = 0;
		globalThis.fetch = mock(async (request, init) => {
			const url = String(request);
			if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
				return Response.json({ drafts: [draft(true)] });
			}
			if (url === `/api/projects/${projectId}/review-rounds`) {
				return Response.json({
					candidates: [{
						id: exportId,
						clipId,
						editorRevision: 3,
						variants: [{
							id: variantId,
							aspectRatio: "ratio_9_16",
							resolution: "1080p",
							durationSec: 30,
							status: "completed",
						}],
					}],
				});
			}
			if (url === "/api/visual-assets") return Response.json({ assets: [] });
			if (url.includes("/thumbnail-extractions?") && !init?.method) {
				return Response.json({ jobs: [] });
			}
			if (
				url === `/api/projects/${projectId}/thumbnail-extractions` &&
				init?.method === "POST"
			) {
				requestCount += 1;
				return await new Promise<Response>((resolve) => {
					requestResolvers.push(resolve);
				});
			}
			throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;

		const container = await renderPanel();
		const thumbnailSource = container.querySelector(
			'[aria-label="Video thumbnail source"]',
		) as HTMLElement;
		await act(async () => {
			thumbnailSource.click();
			await browser.happyDOM.waitUntilComplete();
		});
		const exactFrame = [...browser.document.querySelectorAll('[role="option"]')].find(
			(option) => option.textContent?.includes("Extract an exact frame"),
		) as HTMLElement;
		await act(async () => {
			exactFrame.click();
			await browser.happyDOM.waitUntilComplete();
		});
		const extract = [...container.querySelectorAll("button")].find((entry) =>
			entry.textContent?.includes("Extract exact frames"),
		) as HTMLButtonElement;
		await act(async () => {
			extract.click();
			await Promise.resolve();
		});

		const platform = container.querySelector(
			'[aria-label="Campaign platform"]',
		) as HTMLButtonElement;
		const frameTime = container.querySelector(
			'input[type="number"]',
		) as HTMLInputElement;
		const controlsLocked =
			platform.disabled &&
			(thumbnailSource as HTMLButtonElement).disabled &&
			frameTime.disabled &&
			extract.disabled;
		await act(async () => {
			extract.click();
			await Promise.resolve();
		});
		for (const resolve of requestResolvers) {
			resolve(Response.json(completedThumbnailView()));
		}
		await act(async () => {
			await browser.happyDOM.waitUntilComplete();
		});

		expect(controlsLocked).toBe(true);
		expect(requestCount).toBe(1);
		expect(container.textContent).toContain("completed");
	});



	test("keeps hydrated saved copy visible and read-only when publishing writes are unavailable", async () => {
		const calls: Array<{ url: string; method: string }> = [];
		globalThis.fetch = mock(async (request, init) => {
			const url = String(request);
			calls.push({ url, method: init?.method ?? "GET" });
			if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
				return Response.json({ drafts: [draft(true)] });
			}
			if (url === `/api/projects/${projectId}/review-rounds`) {
				return Response.json({ candidates: [] });
			}
			if (url === "/api/visual-assets") return Response.json({ assets: [] });
			throw new Error(`Unexpected request: ${url}`);
		}) as typeof fetch;

		const container = await renderPanel({ assistedCopyEnabled: false });
		const caption = container.querySelector(
			'textarea[aria-label="Campaign clip caption"]',
		) as HTMLTextAreaElement | null;

		expect(caption?.value).toBe("Hydrated approved caption");
		expect(caption?.readOnly).toBe(true);
		expect(container.textContent).toContain("Saved campaign copy is view-only");
		expect(container.querySelector('[aria-label="Campaign note"]')).toBeNull();
		expect(container.querySelector('[aria-label="Locked terms"]')).toBeNull();
		expect(container.querySelector('[aria-label="Campaign account"]')).toBeNull();
		for (const label of [
			"Generate drafts",
			"Regenerate",
			"Confirm copy",
			"Extract exact frames",
			"Schedule 1",
		]) {
			expect(container.textContent).not.toContain(label);
		}
			expect(calls.every(({ method }) => method === "GET")).toBe(true);
		});

	test("recovers the latest durable thumbnail after reload in read-only mode", async () => {
		const calls: Array<{ url: string; method: string }> = [];
		globalThis.fetch = mock(async (request, init) => {
			const url = String(request);
			const method = init?.method ?? "GET";
			calls.push({ url, method });
			if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
				return Response.json({ drafts: [draft(true)] });
			}
			if (url === `/api/projects/${projectId}/review-rounds`) {
				return Response.json({
					candidates: [{
						id: exportId,
						clipId,
						editorRevision: 3,
						variants: [{
							id: variantId,
							aspectRatio: "ratio_9_16",
							resolution: "1080p",
							durationSec: 30,
							status: "completed",
						}],
					}],
				});
			}
			if (url === "/api/visual-assets") return Response.json({ assets: [] });
			if (
				url ===
				`/api/projects/${projectId}/thumbnail-extractions?platform=tiktok&exportVariantIds=${variantId}`
			) {
				return Response.json({
					jobs: [completedThumbnailView()],
				});
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		}) as typeof fetch;

		const container = await renderPanel({ assistedCopyEnabled: false });

		expect(container.textContent).toContain("Prepared thumbnails");
		expect(container.textContent).toContain("completed");
		expect(
			calls.some(({ url }) => url.includes("/thumbnail-extractions?")),
		).toBe(true);
		expect(calls.every(({ method }) => method === "GET")).toBe(true);
		expect(container.textContent).not.toContain("Retry");
	});

	test("offers a real provider-default choice when YouTube has no eligible image assets", async () => {
		globalThis.fetch = mock(async (request) => {
			const url = String(request);
			if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
				return Response.json({ drafts: [] });
			}
			if (url === `/api/projects/${projectId}/assisted-copy?platform=youtube_shorts`) {
				return Response.json({
					drafts: [{ ...draft(true), platform: "youtube_shorts" }],
				});
			}
			if (url === `/api/projects/${projectId}/review-rounds`) {
				return Response.json({ candidates: [] });
			}
			if (url === "/api/visual-assets") return Response.json({ assets: [] });
			throw new Error(`Unexpected request: ${url}`);
		}) as typeof fetch;

		const container = await renderPanel({
			accounts: [{
				id: accountId,
				platform: "youtube_shorts",
				status: "active",
			} as SocialAccountSnapshot],
		});
		const platformSelect = container.querySelector(
			'[aria-label="Campaign platform"]',
		) as HTMLElement | null;
		await act(async () => {
			platformSelect?.click();
			await browser.happyDOM.waitUntilComplete();
		});
		const youtube = [...browser.document.querySelectorAll('[role="option"]')].find(
			(option) => option.textContent?.includes("YouTube Shorts"),
		) as HTMLElement | undefined;
		await act(async () => {
			youtube?.click();
			await browser.happyDOM.waitUntilComplete();
		});
		const thumbnailSelect = container.querySelector(
			'[aria-label="Campaign thumbnail asset"]',
		) as HTMLElement | null;
		expect(thumbnailSelect).not.toBeNull();
		await act(async () => {
			thumbnailSelect?.click();
			await browser.happyDOM.waitUntilComplete();
		});
		expect(
			[...browser.document.querySelectorAll('[role="option"]')].map(
				(option) => option.textContent?.trim(),
			),
		).toContain("Use provider default");
		expect(container.textContent).toContain(
			"Add an uploaded or generated image to use a custom thumbnail.",
		);
	});

  test("hydrates saved copy, confirms it, and retries a failed frame extraction", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let resolveRetry: ((response: Response) => void) | null = null;
    globalThis.fetch = mock(async (request, init) => {
      const url = String(request);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });

      if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
        return Response.json({ drafts: [draft()] });
      }
      if (url === `/api/projects/${projectId}/review-rounds`) {
        return Response.json({
          candidates: [{
            id: exportId,
            clipId,
            editorRevision: 3,
            variants: [{
              id: variantId,
              aspectRatio: "ratio_9_16",
              resolution: "1080p",
              durationSec: 30,
              status: "completed",
            }],
          }],
        });
      }
      if (url === "/api/visual-assets") return Response.json({ assets: [] });
      if (url.includes("/thumbnail-extractions?") && !init?.method) {
        return Response.json({ jobs: [] });
      }
      if (url === `/api/projects/${projectId}/assisted-copy/${draftId}/confirm`) {
        return Response.json(draft(true));
      }
      if (url === `/api/projects/${projectId}/thumbnail-extractions`) {
        return Response.json({
          id: jobId,
          status: "failed",
          attempts: 1,
          platform: "tiktok",
          exportVariantId: variantId,
          sourceTimeMs: 1_000,
          errorCode: "thumbnail_extraction_failed",
          asset: null,
          replayed: false,
        });
      }
      if (url === `/api/projects/${projectId}/thumbnail-extractions/${jobId}/retry`) {
        return await new Promise<Response>((resolve) => {
          resolveRetry = resolve;
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const container = await renderPanel();
    const caption = container.querySelector(
      'textarea[aria-label="Campaign clip caption"]',
    ) as HTMLTextAreaElement | null;
    expect(caption?.value).toBe("Hydrated approved caption");

    const confirm = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Confirm copy"),
    );
    await act(async () => {
      confirm?.click();
      await browser.happyDOM.waitUntilComplete();
    });
    expect(container.textContent).toContain("Confirmed");
    expect(calls.find(({ url }) => url.endsWith(`/${draftId}/confirm`))?.body).toEqual({
      expectedRevision: 1,
      content: draft().content,
    });

    const thumbnailSource = container.querySelector(
      '[aria-label="Video thumbnail source"]',
    ) as HTMLElement | null;
    await act(async () => {
      thumbnailSource?.click();
      await browser.happyDOM.waitUntilComplete();
    });
    const exactFrame = [...browser.document.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent?.includes("Extract an exact frame"),
    ) as HTMLElement | undefined;
    await act(async () => {
      exactFrame?.click();
      await browser.happyDOM.waitUntilComplete();
    });

    const extract = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Extract exact frames"),
    );
    await act(async () => {
      extract?.click();
      await browser.happyDOM.waitUntilComplete();
    });
    expect(container.textContent).toContain("failed");
    const extractionRequest = calls.find(({ url, method }) =>
      url.endsWith("/thumbnail-extractions") && method === "POST",
    );
    expect(extractionRequest?.body).toMatchObject({
      platform: "tiktok",
      exportVariantId: variantId,
      sourceTimeSec: 1,
    });

    const retry = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry"),
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    const campaignPlatform = container.querySelector(
      '[aria-label="Campaign platform"]',
    ) as HTMLButtonElement;
    const frameTime = container.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement;
    const extractWhileRetrying = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Extract exact frames"),
    ) as HTMLButtonElement;
    expect(campaignPlatform.disabled).toBe(true);
    expect((thumbnailSource as HTMLButtonElement).disabled).toBe(true);
    expect(frameTime.disabled).toBe(true);
    expect(extractWhileRetrying.disabled).toBe(true);
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(calls.filter(({ url }) => url.endsWith(`/${jobId}/retry`))).toHaveLength(1);
    resolveRetry?.(Response.json(completedThumbnailView()));
    await act(async () => {
      await browser.happyDOM.waitUntilComplete();
    });
    expect(container.textContent).toContain("completed");
  });

  test("schedules TikTok with the provider first frame when extraction is unavailable", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = mock(async (request, init) => {
      const url = String(request);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
        return Response.json({ drafts: [draft(true)] });
      }
      if (url === `/api/projects/${projectId}/review-rounds`) {
        return Response.json({
          candidates: [{
            id: exportId,
            clipId,
            editorRevision: 3,
            variants: [{
              id: variantId,
              aspectRatio: "ratio_9_16",
              resolution: "1080p",
              durationSec: 30,
              status: "completed",
            }],
          }],
        });
      }
      if (url === "/api/visual-assets") return Response.json({ assets: [] });
      if (url === `/api/projects/${projectId}/bulk-schedules`) {
        return Response.json({
          operationId: "40000000-0000-4000-8000-000000000009",
          status: "completed",
          counts: { scheduled: 1, failed: 0 },
          items: [{
            itemKey: clipId,
            clipId,
            accountId,
            status: "scheduled",
            postId: "40000000-0000-4000-8000-000000000011",
            scheduledFor: "2026-09-01T09:00:00.000Z",
            errorCode: null,
          }],
          replayed: false,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const container = await renderPanel({
      accounts: [{ id: accountId, platform: "tiktok", status: "active" } as SocialAccountSnapshot],
      thumbnailExtractionEnabled: false,
    });
    const schedule = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Schedule 1"),
    );
    expect(schedule?.disabled).toBe(false);
    await act(async () => {
      schedule?.click();
      await browser.happyDOM.waitUntilComplete();
    });

    const request = calls.find(({ url }) => url.endsWith("/bulk-schedules"));
    expect(request?.body).toMatchObject({
      items: [{ platform: "tiktok", thumbnailAssetId: null }],
    });
  });

  test("keeps exact-frame extraction optional when the feature is available", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = mock(async (request, init) => {
      const url = String(request);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      if (url === `/api/projects/${projectId}/assisted-copy?platform=tiktok`) {
        return Response.json({ drafts: [draft(true)] });
      }
      if (url === `/api/projects/${projectId}/review-rounds`) {
        return Response.json({
          candidates: [{
            id: exportId,
            clipId,
            editorRevision: 3,
            variants: [{
              id: variantId,
              aspectRatio: "ratio_9_16",
              resolution: "1080p",
              durationSec: 30,
              status: "completed",
            }],
          }],
        });
      }
      if (url === "/api/visual-assets") return Response.json({ assets: [] });
      if (url === `/api/projects/${projectId}/bulk-schedules`) {
        return Response.json({
          operationId: "40000000-0000-4000-8000-000000000010",
          status: "completed",
          counts: { scheduled: 1, failed: 0 },
          items: [{
            itemKey: clipId,
            clipId,
            accountId,
            status: "scheduled",
            postId: "40000000-0000-4000-8000-000000000012",
            scheduledFor: "2026-09-01T09:00:00.000Z",
            errorCode: null,
          }],
          replayed: false,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const container = await renderPanel({
      accounts: [{ id: accountId, platform: "tiktok", status: "active" } as SocialAccountSnapshot],
    });
    expect(container.textContent).toContain("Use provider default");
    const schedule = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Schedule 1"),
    );
    expect(schedule?.disabled).toBe(false);
    await act(async () => {
      schedule?.click();
      await browser.happyDOM.waitUntilComplete();
    });

    const request = calls.find(({ url }) => url.endsWith("/bulk-schedules"));
    expect(request?.body).toMatchObject({ items: [{ thumbnailAssetId: null }] });
    expect(calls.some(({ url }) => url.endsWith("/thumbnail-extractions"))).toBe(false);
  });
});
