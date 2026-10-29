import { afterAll, afterEach, beforeAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
let createRoot: typeof import("react-dom/client").createRoot;
let useInternalReviews: typeof import("../../(app)/projects/[projectId]/review-panel").useInternalReviews;
let internalRuntime: import("@narriflow/api-client/core").ApiRuntime;
const internalScope = { userId: "clerk-user", workspaceId: "workspace-test" };
mock.module("../../_components/api-provider", () => ({ useApiRuntime: () => internalRuntime, useWorkspaceScope: () => internalScope }));

const apiOrigin = "https://api.review.test";
const originalApiOrigin = process.env.NEXT_PUBLIC_API_URL;
const originalFetch = globalThis.fetch;
const browser = new Window({ url: "http://localhost:3000/review/private-token" });
let ReviewClient: typeof import("./review-client").ReviewClient;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root | null = null;
let SharedExportPageClient: typeof import("../../share/[token]/shared-export-client").SharedExportPageClient;
let ReviewOptOutPage: typeof import("../opt-out/page").default;
mock.module("next/navigation", () => ({ useSearchParams: () => new URL(browser.location.href).searchParams }));

function installBrowserGlobals() {
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLVideoElement: browser.HTMLVideoElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
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

async function settle() {
  for (let tick = 0; tick < 6; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function renderReview(view?: ReactNode) {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root?.render(
      <ChakraProvider value={system}>
        {view ?? <ReviewClient token="private-token" />}
      </ChakraProvider>,
    );
    await browser.happyDOM.waitUntilComplete();
  });
  await settle();
  return container;
}

function enter(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new browser.InputEvent("input", { bubbles: true, data: value }));
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_API_URL = apiOrigin;
  installBrowserGlobals();
  ({ createRoot } = await import("react-dom/client"));
  ({ ReviewClient } = await import("./review-client"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ system } = await import("@narriflow/ui/theme"));
  ({ SharedExportPageClient } = await import("../../share/[token]/shared-export-client"));
  ({ default: ReviewOptOutPage } = await import("../opt-out/page"));
  ({ useInternalReviews } = await import("../../(app)/projects/[projectId]/review-panel"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
  browser.sessionStorage.clear();
  globalThis.fetch = originalFetch;
  setSystemTime();
});

afterAll(() => { browser.close(); if (originalApiOrigin === undefined) delete process.env.NEXT_PUBLIC_API_URL; else process.env.NEXT_PUBLIC_API_URL = originalApiOrigin; });

describe("guest review browser contract", () => {
  test("labels access fields and focuses an inline access failure", async () => {
    let focusedRole: string | null = null;
    const originalFocus = browser.HTMLElement.prototype.focus;
    browser.HTMLElement.prototype.focus = function focus(options?: FocusOptions) {
      focusedRole = this.getAttribute("role");
      originalFocus.call(this, options);
    };
    globalThis.fetch = mock(async (_input, init) => init?.method === "POST"
      ? Response.json({ error: "review_passcode_invalid", message: "That passcode is not valid." }, { status: 403 })
      : Response.json({ error: "review_session_invalid", message: "Access required." }, { status: 401 })) as unknown as typeof fetch;
    const container = await renderReview();
    expect(container.querySelector("h1")?.textContent).toBe("Enter the review room");
    expect(container.querySelector('label[for="reviewer-name"]')).not.toBeNull();
    expect(container.querySelector('label[for="reviewer-email"]')).not.toBeNull();

    await act(async () => {
      enter(container.querySelector("#reviewer-name") as HTMLInputElement, "Client reviewer");
      enter(container.querySelector("#reviewer-email") as HTMLInputElement, "client@example.test");
    });
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.requestSubmit();
      await browser.happyDOM.waitUntilComplete();
      await new Promise((resolve) => browser.setTimeout(resolve, 10));
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("passcode");
    expect(focusedRole).toBe("alert");
    browser.HTMLElement.prototype.focus = originalFocus;
  });

  test("renders native media controls and named review regions after access", async () => {
    const { sha256Hex } = await import("@narriflow/api-client/core");
    const { reviewSessionKey } = await import("./review-client-model");
    browser.sessionStorage.setItem(reviewSessionKey(await sha256Hex("private-token")), JSON.stringify({ sessionToken: "guest-session", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    globalThis.fetch = mock(async (input, init) => {
      const url = new URL(input.toString());
      calls.push({ url, init });
      if (url.pathname.includes("/media/")) return Response.json({ url: "https://storage.review.test/clip.mp4", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      return Response.json({
      round: {
        id: "round-1",
        title: "Launch review",
        message: "Check the opening beat.",
        projectTitle: "Existing project footage",
        agencyName: "Narriflow",
        revision: 2,
        status: "open",
        allowDownloads: false,
        approvalRequired: true,
        reviewer: "Client reviewer",
        items: [{
          id: "item-1",
          clipTitle: "Opening clip",
          required: true,
          currentDecision: null,
          export: { variants: [{ id: "variant-1", aspectRatio: "ratio_9_16", durationSec: 12, status: "completed" }] },
        }],
        comments: [],
      },
    }); }) as typeof fetch;
    const container = await renderReview();
    const video = container.querySelector("video") as HTMLVideoElement;

    expect(container.querySelector("h1")?.textContent).toBe("Existing project footage");
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Opening clip");
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-label")).toBe("Opening clip");
    expect(video.controls).toBe(true);
    expect(video.src).toBe("https://storage.review.test/clip.mp4");
    expect(calls.every(({ url, init }) => url.origin === apiOrigin && init?.credentials === "omit" && new Headers(init.headers).get("Authorization") === "Bearer guest-session")).toBe(true);
    expect(calls.every(({ init }) => !new Headers(init?.headers).has("X-Workspace-Id"))).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.getAttribute("aria-label")).toContain("submitted export");
    expect(container.querySelector('textarea[aria-label="Review comment"]')).not.toBeNull();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Clip feedback"))).toBe(true);
  });
});


async function seedSession(milliseconds = 60_000) {
  const { sha256Hex } = await import("@narriflow/api-client/core");
  const { reviewSessionKey } = await import("./review-client-model");
  const digest = await sha256Hex("private-token");
  const key = reviewSessionKey(digest);
  browser.sessionStorage.setItem(key, JSON.stringify({ sessionToken: "guest-session", expiresAt: new Date(Date.now() + milliseconds).toISOString() }));
  return key;
}

const snapshot = {
  round: {
    id: "round-1", title: "Launch review", message: null, projectTitle: "Project", agencyName: "Team", revision: 1,
    status: "open", allowDownloads: false, approvalRequired: true, reviewer: "Reviewer",
    items: [{ id: "item-1", clipTitle: "Clip", required: true, currentDecision: null, export: { variants: [{ id: "variant-1", aspectRatio: "ratio_9_16", durationSec: 20, status: "completed" }] } }], comments: [],
  },
};
function grant() { return { url: "https://storage.review.test/media.mp4", expiresAt: new Date(Date.now() + 60_000).toISOString() }; }

test("expired tab access is removed before any guest read", async () => {
  const key = await seedSession(-1);
  const fetcher = mock(async () => Response.json(snapshot));
  globalThis.fetch = fetcher as typeof fetch;
  const container = await renderReview();
  expect(container.querySelector("h1")?.textContent).toBe("Enter the review room");
  expect(browser.sessionStorage.getItem(key)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

test("a refused guest session is cleared and requires explicit access again", async () => {
  const key = await seedSession();
  globalThis.fetch = mock(async () => Response.json({ error: "review_session_invalid", message: "Access expired" }, { status: 401 })) as typeof fetch;
  const container = await renderReview();
  expect(container.querySelector("h1")?.textContent).toBe("Enter the review room");
  expect(browser.sessionStorage.getItem(key)).toBeNull();
});

test("guest comments retain their intent key and playhead through a lost response", async () => {
  await seedSession();
  const comments: Array<{ key: string | null; body: string }> = [];
  let mediaReads = 0;
  globalThis.fetch = mock(async (input, init) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/comments")) {
      comments.push({ key: new Headers(init?.headers).get("Idempotency-Key"), body: String(init?.body) });
      if (comments.length === 1) throw new TypeError("response lost");
      return Response.json({ id: "comment-1" }, { status: 201 });
    }
    if (url.pathname.includes("/media/")) { mediaReads += 1; return Response.json(grant()); }
    return Response.json(snapshot);
  }) as typeof fetch;
  const container = await renderReview();
  const field = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")?.set?.call(field, "Keep this beat"); field.dispatchEvent(new browser.InputEvent("input", { bubbles: true })); });
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Comment")!;
  const video = container.querySelector("video") as HTMLVideoElement;
  video.currentTime = 4;
  await act(async () => button.click()); await settle();
  expect(comments).toHaveLength(1);
  video.currentTime = 9;
  await act(async () => button.click()); await settle();
  expect(comments).toHaveLength(2);
  expect(comments[0]).toEqual(comments[1]);
  expect(comments[0]?.key).toBeTruthy();
  expect(JSON.parse(comments[0]!.body).timestampSec).toBe(4);
  expect(mediaReads).toBe(1);
  expect(container.textContent).toContain("Comment added at");
});

test("long review playback and paused focus keep the mounted URL through background renewal", async () => {
  const now = Date.now();
  await seedSession(3_600_000);
  let mediaReads = 0;
  let roomReads = 0;
  globalThis.fetch = mock(async (input) => {
    if (new URL(input.toString()).pathname.includes("/media/")) {
      mediaReads += 1;
      return Response.json({ url: `https://storage.review.test/${mediaReads}.mp4`, expiresAt: new Date(Date.now() + 900_000).toISOString() });
    }
    roomReads += 1;
    return Response.json(snapshot);
  }) as typeof fetch;
  const container = await renderReview();
  const video = container.querySelector("video") as HTMLVideoElement;
  await act(async () => video.play());
  video.currentTime = 75;
  setSystemTime(now + 75_000);
  await act(async () => browser.dispatchEvent(new browser.Event("focus")));
  await settle();
  expect(mediaReads).toBe(1);
  expect(video.src).toBe("https://storage.review.test/1.mp4");
  expect(video.currentTime).toBe(75);
  expect(video.paused).toBe(false);

  await act(async () => video.pause());
  setSystemTime(now + 880_000);
  await act(async () => browser.dispatchEvent(new browser.Event("focus")));
  await settle();
  expect(mediaReads).toBe(2);
  expect(roomReads).toBe(1);
  expect(container.querySelector("video")).toBe(video);
  expect(video.src).toBe("https://storage.review.test/1.mp4");
  expect(video.currentTime).toBe(75);
  expect(video.paused).toBe(true);

  // The selected URL may expire while paused; the next play adopts the fresh cached grant.
  setSystemTime(now + 910_000);
  await act(async () => video.play());
  await settle();
  expect(mediaReads).toBe(2);
  expect(video.src).toBe("https://storage.review.test/2.mp4");
  await act(async () => {
    video.currentTime = 0;
    video.dispatchEvent(new browser.Event("loadedmetadata"));
  });
  expect(video.currentTime).toBe(75);
  expect(video.paused).toBe(false);
});

test("an expired playback error renews the grant and restores the playhead", async () => {
  const now = Date.now();
  await seedSession(3_600_000);
  let mediaReads = 0;
  globalThis.fetch = mock(async (input) => {
    if (new URL(input.toString()).pathname.includes("/media/")) {
      mediaReads += 1;
      return Response.json({ url: `https://storage.review.test/recovered-${mediaReads}.mp4`, expiresAt: new Date(Date.now() + 900_000).toISOString() });
    }
    return Response.json(snapshot);
  }) as typeof fetch;
  const container = await renderReview();
  const video = container.querySelector("video") as HTMLVideoElement;
  await act(async () => video.play());
  video.currentTime = 135;
  setSystemTime(now + 910_000);
  await act(async () => video.dispatchEvent(new browser.Event("error")));
  await settle();
  expect(mediaReads).toBe(2);
  expect(video.src).toBe("https://storage.review.test/recovered-2.mp4");
  await act(async () => {
    video.currentTime = 0;
    video.dispatchEvent(new browser.Event("loadedmetadata"));
  });
  expect(video.currentTime).toBe(135);
  expect(video.paused).toBe(false);
});

test("switching the selected review item mounts its own playback grant", async () => {
  await seedSession();
  const second = { ...snapshot.round.items[0]!, id: "item-2", clipTitle: "Second clip", export: { variants: [{ id: "variant-2", aspectRatio: "ratio_1_1", durationSec: 40, status: "completed" }] } };
  globalThis.fetch = mock(async (input) => {
    const path = new URL(input.toString()).pathname;
    if (path.includes("/media/")) return Response.json({ ...grant(), url: `https://storage.review.test/${path.includes("item-2") ? "second" : "first"}.mp4` });
    return Response.json({ round: { ...snapshot.round, items: [...snapshot.round.items, second] } });
  }) as typeof fetch;
  const container = await renderReview();
  const first = container.querySelector("video") as HTMLVideoElement;
  first.currentTime = 12;
  await act(async () => {
    const tab = [...container.querySelectorAll('[role="tab"]')].find(entry => entry.textContent?.includes("Second clip")) as HTMLButtonElement;
    tab.click();
  });
  await settle();
  const secondVideo = container.querySelector("video") as HTMLVideoElement;
  expect(secondVideo).not.toBe(first);
  expect(secondVideo.src).toBe("https://storage.review.test/second.mp4");
  expect(secondVideo.currentTime).toBe(0);
});

test("review copy renders untrusted text without HTML interpolation", async () => {
  await seedSession();
  const text = '<img src=x onerror="window.reviewCredentialLeak=true">';
  globalThis.fetch = mock(async input => Response.json(new URL(input.toString()).pathname.includes("/media/")
    ? grant()
    : { round: { ...snapshot.round, projectTitle: text, message: text } })) as typeof fetch;
  const container = await renderReview();
  expect(container.querySelector("h1")?.textContent).toBe(text);
  expect(container.textContent).toContain(text);
  expect(container.querySelector('img[src="x"]')).toBeNull();
});

test("opt-out previews on GET and confirms only after the person's click", async () => {
  browser.location.href = "http://localhost:3000/review/opt-out?token=signed-opt-out";
  const methods: string[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    methods.push(init?.method ?? "GET");
    return Response.json(init?.method === "POST" ? { workspaceName: "Acme" } : { workspaceName: "Acme", email: "reviewer@example.test" });
  }) as typeof fetch;
  const container = await renderReview(<ReviewOptOutPage />);
  expect(methods).toEqual(["GET"]);
  expect(container.textContent).toContain("reviewer@example.test");
  const button = container.querySelector("button")!;
  await act(async () => button.click()); await settle();
  expect(methods).toEqual(["GET", "POST"]);
  expect(container.querySelector("h1")?.textContent).toBe("You're opted out");
  await act(async () => root?.unmount()); root = null;
  expect(methods).toEqual(["GET", "POST"]);
});

test("public shares use a separate credential-free read and retain storage links", async () => {
  const calls: Array<{ origin: string; headers: Headers }> = [];
  globalThis.fetch = mock(async (input, init) => {
    calls.push({ origin: new URL(input.toString()).origin, headers: new Headers(init?.headers) });
    return Response.json({
      id: "export-1", clipTitle: "Shared clip", projectTitle: "Project", createdAt: new Date().toISOString(), editorRevision: 3,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      variants: [{ id: "variant-1", aspectRatio: "9:16", resolution: "1080p", sizeBytes: 1024, durationSec: 20, hasAsset: true, previewUrl: "https://storage.review.test/preview.mp4", downloadUrl: "https://storage.review.test/download.mp4" }],
    });
  }) as typeof fetch;
  const container = await renderReview(<SharedExportPageClient token="public-share" />);
  expect(container.querySelector("h1")?.textContent).toBe("Shared clip");
  expect(container.querySelector("video")?.getAttribute("src")).toBe("https://storage.review.test/preview.mp4");
  expect(container.querySelector("a[download]")?.getAttribute("href")).toBe("https://storage.review.test/download.mp4");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.origin).toBe(apiOrigin);
  expect(calls[0]?.headers.has("Authorization")).toBe(false);
  expect(calls[0]?.headers.has("X-Workspace-Id")).toBe(false);
});


test("shared video keeps its source and playhead while expiry refresh updates download links", async () => {
  const now = Date.now();
  let reads = 0;
  globalThis.fetch = mock(async () => {
    reads += 1;
    return Response.json({
      id: "export-1", clipTitle: "Shared clip", projectTitle: "Project", createdAt: new Date(now).toISOString(), editorRevision: 3,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      variants: [{ id: "variant-1", aspectRatio: "9:16", resolution: "1080p", sizeBytes: 1024, durationSec: 200, hasAsset: true, previewUrl: `https://storage.review.test/preview-${reads}.mp4`, downloadUrl: `https://storage.review.test/download-${reads}.mp4` }],
    });
  }) as typeof fetch;
  const container = await renderReview(<SharedExportPageClient token="public-share" />);
  const video = container.querySelector("video") as HTMLVideoElement;
  await act(async () => video.play());
  video.currentTime = 125;
  setSystemTime(now + 125_000);
  await act(async () => browser.dispatchEvent(new browser.Event("focus")));
  await settle();
  expect(reads).toBe(1);
  expect(video.src).toBe("https://storage.review.test/preview-1.mp4");
  expect(video.currentTime).toBe(125);

  setSystemTime(now + 880_000);
  await act(async () => browser.dispatchEvent(new browser.Event("focus")));
  await settle();
  expect(reads).toBe(2);
  expect(container.querySelector("video")).toBe(video);
  expect(video.src).toBe("https://storage.review.test/preview-1.mp4");
  expect(video.currentTime).toBe(125);
  expect(video.paused).toBe(false);
  expect(container.querySelector("a[download]")?.getAttribute("href")).toBe("https://storage.review.test/download-2.mp4");

  setSystemTime(now + 910_000);
  await act(async () => browser.dispatchEvent(new browser.Event("focus")));
  await settle();
  expect(video.src).toBe("https://storage.review.test/preview-1.mp4");
  expect(video.currentTime).toBe(125);
  await act(async () => video.pause());
  await act(async () => browser.dispatchEvent(new browser.Event("focus")));
  await settle();
  expect(video.src).toBe("https://storage.review.test/preview-1.mp4");
  expect(video.paused).toBe(true);
  await act(async () => video.play());
  await settle();
  expect(reads).toBe(2);
  expect(video.src).toBe("https://storage.review.test/preview-2.mp4");
  await act(async () => {
    video.currentTime = 0;
    video.dispatchEvent(new browser.Event("loadedmetadata"));
  });
  expect(video.currentTime).toBe(125);
  expect(video.paused).toBe(false);
});

test("a share without completed downloadable media uses its existing unavailable view", async () => {
  globalThis.fetch = mock(async () => Response.json({
    id: "export-empty", clipTitle: "Shared clip", projectTitle: "Project", createdAt: new Date().toISOString(), editorRevision: 3,
    expiresAt: new Date(Date.now() + 900_000).toISOString(), variants: [],
  })) as typeof fetch;
  const container = await renderReview(<SharedExportPageClient token="empty-share" />);
  expect(container.querySelector("h1")?.textContent).toBe("This link isn't available");
  expect(container.querySelector("video")).toBeNull();
});


test("internal review commands preserve scoped intents and invalidate only affected reads", async () => {
  const { createApiRuntime, scopedKey } = await import("@narriflow/api-client/core");
  const { QueryClientProvider } = await import("@tanstack/react-query");
  const { buildQuickReviewRoundInput } = await import("../../(app)/projects/[projectId]/project-share-model");
  const room = { project: { title: "Project", workspace: { name: "Team" }, approvalRequiredByDefault: true }, candidates: [], rounds: [] };
  const posts: Array<{ key: string | null; workspace: string | null; auth: string | null }> = [];
  let reads = 0;
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "POST") {
      const headers = new Headers(init.headers);
      posts.push({ key: headers.get("Idempotency-Key"), workspace: headers.get("X-Workspace-Id"), auth: headers.get("Authorization") });
      if (posts.length === 1) throw new TypeError("response lost");
      return Response.json({ id: "round-created" }, { headers: { "X-Workspace-Id": internalScope.workspaceId } });
    }
    reads += 1;
    expect(init?.signal).toBeDefined();
    return Response.json(room, { headers: { "X-Workspace-Id": internalScope.workspaceId } });
  }) as typeof fetch;
  internalRuntime = createApiRuntime({ baseUrl: apiOrigin, getToken: async () => "clerk-session", fetch: (input, init) => globalThis.fetch(input, init) });
  internalRuntime.setIdentity(internalScope.userId);
  internalRuntime.selectWorkspace(internalScope.workspaceId);
  const detailKey = scopedKey(internalScope, "projects", "detail", "project-1");
  const foreignKey = scopedKey({ ...internalScope, workspaceId: "workspace-other" }, "projects", "detail", "project-1");
  const unrelatedKey = scopedKey(internalScope, "brand", "overview");
  for (const key of [detailKey, foreignKey, unrelatedKey]) internalRuntime.queryClient.setQueryData(key, {});
  function Commands() {
    const { room: query, mutation } = useInternalReviews("project-1");
    return <button type="button" disabled={!query.data || mutation.isPending} onClick={() => void mutation.mutateAsync({ kind: "create", input: buildQuickReviewRoundInput(room, []) }).catch(() => undefined)}>Create</button>;
  }
  const container = await renderReview(<QueryClientProvider client={internalRuntime.queryClient}><Commands /></QueryClientProvider>);
  const button = container.querySelector("button")!;
  await act(async () => button.click()); await settle();
  expect(posts).toHaveLength(1);
  expect(internalRuntime.queryClient.getQueryState(detailKey)?.isInvalidated).toBe(false);
  await act(async () => button.click()); await settle();
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[1]?.key).toBeTruthy();
  expect(posts[1]?.workspace).toBe(internalScope.workspaceId);
  expect(posts[1]?.auth).toBe("Bearer clerk-session");
  expect(reads).toBe(2);
  expect(internalRuntime.queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
  expect(internalRuntime.queryClient.getQueryState(foreignKey)?.isInvalidated).toBe(false);
  expect(internalRuntime.queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
  await act(async () => root?.unmount()); root = null;
  internalRuntime.queryClient.clear();
});


test("mounted guest access expires without silently exchanging a fresh credential", async () => {
  const key = await seedSession(250);
  const methods: string[] = [];
  globalThis.fetch = mock(async (input, init) => {
    methods.push(init?.method ?? "GET");
    return Response.json(new URL(input.toString()).pathname.includes("/media/") ? grant() : snapshot);
  }) as typeof fetch;
  const container = await renderReview();
  expect(container.querySelector("video")).not.toBeNull();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); }); await settle();
  expect(container.querySelector("h1")?.textContent).toBe("Enter the review room");
  expect(browser.sessionStorage.getItem(key)).toBeNull();
  expect(methods.every((method) => method === "GET")).toBe(true);
});
