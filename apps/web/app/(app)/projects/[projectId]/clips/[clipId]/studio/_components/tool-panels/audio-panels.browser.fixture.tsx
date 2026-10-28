import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { createApiRuntime } from "@narriflow/api-client/core";
import { studioEditsSchema, type BrandAudioSnapshot } from "@narriflow/validators";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

const browser = new Window({ url: "http://localhost:3000/studio" });
const noBrandAudio: BrandAudioSnapshot = { music: [], sfx: [] };
const studio = {
  studioEdits: studioEditsSchema.parse({}),
  brandAudio: noBrandAudio,
  setStudioEdits: mock((_update: unknown) => {}),
  endCoalesce() {},
  playbackClock: { getSnapshot: () => 0, subscribe: () => () => {} },
};
mock.module("../studio-shell", () => ({ useStudio: () => studio }));

// The audio helpers call the Brand API through the shared runtime. Requests go to
// an absolute API origin with a Bearer token and reach the per-test `globalThis.fetch`.
const apiRuntime = createApiRuntime({
  baseUrl: "https://api.test",
  getToken: async () => "token",
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
});
apiRuntime.setIdentity("user_1");
apiRuntime.selectWorkspace("ws_1");
const workspaceScope = { userId: "user_1", workspaceId: "ws_1" };
mock.module("../../../../../../../../_components/api-provider", () => ({
  useApiRuntime: () => apiRuntime,
  useWorkspaceScope: () => workspaceScope,
}));

let UploadsTab: typeof import("./uploads-tab").UploadsTab;
let MusicPanel: typeof import("./music-panel").MusicPanel;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let createRoot: typeof import("react-dom/client").createRoot;
let root: Root | null = null;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
    Element: browser.Element, Node: browser.Node, Event: browser.Event,
    MouseEvent: browser.MouseEvent, MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver, CSS: browser.CSS,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: (callback: FrameRequestCallback) => browser.setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => browser.clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
    Audio: class extends browser.EventTarget {
      duration = 2;
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new browser.Event("loadedmetadata")));
      }
    },
  });
  ({ createRoot } = await import("react-dom/client"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ system } = await import("@narriflow/ui/theme"));
  ({ UploadsTab } = await import("./uploads-tab"));
  ({ MusicPanel } = await import("./music-panel"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
  globalThis.fetch = realFetch;
  studio.brandAudio = noBrandAudio;
  studio.studioEdits = studioEditsSchema.parse({});
  studio.setStudioEdits.mockReset();
});
afterAll(() => browser.happyDOM.abort());

async function mount(node: React.ReactNode) {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root?.render(<ChakraProvider value={system}>{node}</ChakraProvider>); });
  return container;
}

test.each([
  { name: "WAV browser variant", filename: "Track.WAV", reported: "audio/vnd.wave", expected: "audio/wav" },
  { name: "M4A browser variant", filename: "Track.m4a", reported: "video/mp4", expected: "audio/mp4" },
  { name: "MP3 browser variant", filename: "Track.mp3", reported: "application/octet-stream", expected: "audio/mpeg" },
  { name: "empty MIME", filename: "Track.m4a", reported: "", expected: "audio/mp4" },
  { name: "accepted MIME", filename: "Track.wav", reported: "audio/x-wav", expected: "audio/x-wav" },
])("$name uploads with an accepted content type", async ({ filename, reported, expected }) => {
  let presignBody: unknown;
  let uploadedContentType: string | null = null;
  let finalizeBody: unknown;
  let changed = false;
  globalThis.fetch = mock(async (url, init) => {
    if (String(url).endsWith("presign-upload")) {
      presignBody = JSON.parse(String(init?.body));
      return Response.json({ key: "audio/track", uploadUrl: "https://upload.test/track", contentType: expected });
    }
    if (init?.method === "PUT") {
      uploadedContentType = new Headers(init.headers).get("Content-Type");
      return new Response(null, { status: 200 });
    }
    if (init?.method === "POST") finalizeBody = JSON.parse(String(init.body));
    return Response.json({ assets: [], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<UploadsTab reloadKey={0} onLibraryChange={() => { changed = true; }} />);
  const input = container.querySelector('input[type="file"]')!;
  const file = new File(["audio"], filename, { type: reported });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  expect(presignBody).toEqual({ contentType: expected, sizeBytes: 5 });
  expect(uploadedContentType).toBe(expected);
  expect(finalizeBody).toEqual({ key: "audio/track", kind: "music", title: "Track", durationSec: 2, sizeBytes: 5 });
  expect(changed).toBe(true);
});

test("an unsupported MIME and extension never request an upload grant", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (_url, init) => {
    requests.push(init?.method ?? "GET");
    return Response.json({ assets: [], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<UploadsTab reloadKey={0} onLibraryChange={() => {}} />);
  const input = container.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [new File(["text"], "notes.txt", { type: "text/plain" })], configurable: true });
  await act(async () => { input.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  expect(requests).toEqual(["GET", "GET"]);
});

test.each(["music", "sfx", "uploads"] as const)("%s lists recover from a transient failure without leaving the panel", async (view) => {
  const requests = new Map<string, number>();
  globalThis.fetch = mock(async (url) => {
    const kind = new URL(String(url), "http://localhost").searchParams.get("kind")!;
    const count = (requests.get(kind) ?? 0) + 1;
    requests.set(kind, count);
    if (count === 1) return new Response(null, { status: 503 });
    return Response.json({ assets: [{
      id: `${kind}-track`, kind, scope: "user", title: `Recovered ${kind}`,
      moodTags: [], durationSec: 2, favorited: false,
    }], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(view === "uploads"
    ? <UploadsTab reloadKey={0} onLibraryChange={() => {}} />
    : <MusicPanel />);
  if (view === "sfx") {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Sound effects")!;
    await act(async () => { (tab as unknown as HTMLButtonElement).click(); });
  }
  expect(container.textContent).toContain("Couldn't load");
  const retry = [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
  expect(retry).toBeDefined();
  await act(async () => { retry!.click(); });
  expect(container.textContent).not.toContain("Couldn't load");
  expect(container.textContent).toContain(`Recovered ${view === "sfx" ? "sfx" : "music"}`);
  if (view === "uploads") expect(container.textContent).toContain("Recovered sfx");
  expect(requests.get(view === "sfx" ? "sfx" : "music")).toBe(2);
});

test.each(["music", "sfx"] as const)("%s search clear, upload, and source mute controls have 24px targets", async (kind) => {
  globalThis.fetch = mock(async () => Response.json({ assets: [], moodTags: [], nextOffset: null })) as typeof fetch;
  const container = await mount(<MusicPanel />);
  if (kind === "sfx") {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Sound effects")!;
    await act(async () => { (tab as unknown as HTMLButtonElement).click(); });
  }
  const expectTarget = (button: Element | undefined | null) => {
    expect(button).toBeTruthy();
    const style = browser.getComputedStyle(button as never);
    expect(Math.max(parseFloat(style.height) || 0, parseFloat(style.minHeight) || 0)).toBeGreaterThanOrEqual(24);
    expect(Math.max(parseFloat(style.width) || 0, parseFloat(style.minWidth) || 0)).toBeGreaterThanOrEqual(24);
  };
  expectTarget([...container.querySelectorAll("button")].find((node) => node.textContent?.includes(kind === "music" ? "Upload a track" : "Upload an effect")));
  expectTarget(container.querySelector('[aria-label="Mute source audio"]'));
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "query");
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  const clear = container.querySelector(`[aria-label="${kind === "music" ? "Clear music search" : "Clear effect search"}"]`);
  expectTarget(clear);
  await act(async () => { (clear as unknown as HTMLButtonElement).click(); });
  expect(input.value).toBe("");
});


test.each(["music", "sfx", "uploads"] as const)("%s appends metadata pages and retries a failed next page", async (view) => {
  const requests: URL[] = [];
  let failNext = true;
  globalThis.fetch = mock(async (url) => {
    const request = new URL(String(url), "http://localhost");
    requests.push(request);
    const kind = request.searchParams.get("kind")!;
    const offset = Number(request.searchParams.get("offset") ?? 0);
    if (offset > 0 && failNext) {
      failNext = false;
      return new Response(null, { status: 503 });
    }
    return Response.json({ assets: [{
      id: `${kind}-${offset}`, kind, scope: "user", title: `${offset ? "Second" : "First"} ${kind}`,
      moodTags: [], durationSec: 2, favorited: false,
    }], moodTags: [], nextOffset: offset === 0 ? 1 : null });
  }) as typeof fetch;
  const container = await mount(view === "uploads"
    ? <UploadsTab reloadKey={0} onLibraryChange={() => {}} /> : <MusicPanel />);
  if (view === "sfx") {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Sound effects")!;
    await act(async () => { (tab as unknown as HTMLButtonElement).click(); });
  }
  const clickText = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === label);
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
  };
  expect(container.textContent).toContain(`First ${view === "sfx" ? "sfx" : "music"}`);
  await clickText("Load more");
  expect(container.textContent).toContain(`First ${view === "sfx" ? "sfx" : "music"}`);
  expect(container.textContent).toContain("Couldn't load");
  await clickText("Retry");
  expect(container.textContent).toContain(`Second ${view === "sfx" ? "sfx" : "music"}`);
  expect(container.textContent).not.toContain("Couldn't load");
  expect([...container.querySelectorAll("button")].some((node) => node.textContent === "Load more")).toBe(false);
  if (view === "uploads") expect(requests.every((url) => url.searchParams.get("scope") === "user")).toBe(true);
  expect(requests.some((url) => url.pathname.includes("playback-url"))).toBe(false);
});

test("music resolves playback only when previewing or applying a track", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (url) => {
    requests.push(String(url));
    if (String(url).includes("playback-url")) return Response.json({ url: "https://audio.test/lazy.mp3", durationSec: 2 });
    return Response.json({ assets: [{ id: "track", kind: "music", scope: "curated", title: "Lazy track", moodTags: [], durationSec: 2, favorited: false }], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  expect(requests).toHaveLength(1);
  await act(async () => { (container.querySelector('[aria-label="Preview Lazy track"]') as unknown as HTMLButtonElement).click(); });
  expect(requests.filter((url) => url.includes("playback-url"))).toHaveLength(1);
  expect(container.querySelector("audio")!.getAttribute("src")).toBe("https://audio.test/lazy.mp3");
  await act(async () => { (container.querySelector('[aria-label="Use Lazy track"]') as unknown as HTMLButtonElement).click(); });
  expect(requests.filter((url) => url.includes("playback-url"))).toHaveLength(2);
});

test.each(["music", "sfx"] as const)("%s searches the server from page one and ignores an older pending page", async (kind) => {
  const requests: URL[] = [];
  let finishPage: (response: Response) => void = () => { throw new Error("No page pending"); };
  const page = (title: string, nextOffset: number | null) => Response.json({ assets: [{
    id: title, kind, scope: "curated", title, moodTags: ["Calm"], durationSec: 2, favorited: true,
  }], moodTags: ["Calm"], nextOffset });
  globalThis.fetch = mock(async (url) => {
    const request = new URL(String(url), "http://localhost");
    requests.push(request);
    if (Number(request.searchParams.get("offset")) > 0) return new Promise<Response>((resolve) => { finishPage = resolve; });
    return page(request.searchParams.get("search") ? "Needle match" : "Earlier track", request.searchParams.get("search") ? null : 1);
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  if (kind === "sfx") {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Sound effects")!;
    await act(async () => { (tab as unknown as HTMLButtonElement).click(); });
  }
  const more = [...container.querySelectorAll("button")].find((node) => node.textContent === "Load more")!;
  await act(async () => { more.click(); });
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "Needle");
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  expect(requests.at(-1)!.searchParams.get("offset")).toBe("0");
  expect(requests.at(-1)!.searchParams.get("search")).toBe("Needle");
  expect(container.textContent).toContain("Needle match");
  expect(container.textContent).not.toContain("Earlier track");
  await act(async () => { finishPage(page("Stale track", 2)); });
  expect(container.textContent).not.toContain("Stale track");
  const saved = [...container.querySelectorAll("button")].find((node) => node.textContent === "Saved")!;
  await act(async () => { saved.click(); });
  expect(requests.at(-1)!.searchParams.get("favorited")).toBe("true");
  const calm = [...container.querySelectorAll("button")].find((node) => node.textContent === "Calm")!;
  await act(async () => { calm.click(); });
  expect(requests.at(-1)!.searchParams.get("mood")).toBe("Calm");
});

test("the most recent preview wins when playback URL responses arrive out of order", async () => {
  let finishFirst: (response: Response) => void = () => { throw new Error("No preview pending"); };
  globalThis.fetch = mock(async (url) => {
    if (String(url).includes("/first/playback-url")) return new Promise<Response>((resolve) => { finishFirst = resolve; });
    if (String(url).includes("/second/playback-url")) return Response.json({ url: "https://audio.test/second.mp3", durationSec: 2 });
    return Response.json({ assets: ["first", "second"].map((id) => ({ id, kind: "music", scope: "curated", title: id, moodTags: [], durationSec: 2, favorited: false })), moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  await act(async () => { (container.querySelector('[aria-label="Preview first"]') as unknown as HTMLButtonElement).click(); });
  await act(async () => { (container.querySelector('[aria-label="Preview second"]') as unknown as HTMLButtonElement).click(); });
  await act(async () => { finishFirst(Response.json({ url: "https://audio.test/first.mp3", durationSec: 2 })); });
  expect(container.querySelector("audio")!.getAttribute("src")).toBe("https://audio.test/second.mp3");
});

test.each(["music", "sfx"] as const)("%s playback URL failures can be retried from the same row", async (kind) => {
  let playbackRequests = 0;
  globalThis.fetch = mock(async (url) => {
    if (String(url).includes("playback-url")) {
      playbackRequests++;
      return playbackRequests === 1 ? new Response(null, { status: 503 }) : Response.json({ url: "https://audio.test/recovered.mp3", durationSec: 2 });
    }
    return Response.json({ assets: [{ id: "retry", kind, scope: "curated", title: "Retry preview", moodTags: [], durationSec: 2, favorited: false }], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  if (kind === "sfx") {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Sound effects")!;
    await act(async () => { (tab as unknown as HTMLButtonElement).click(); });
  }
  const preview = () => container.querySelector('[aria-label="Preview Retry preview"]') as unknown as HTMLButtonElement;
  await act(async () => { preview().click(); });
  expect(playbackRequests).toBe(1);
  expect(container.querySelector("audio")!.getAttribute("src")).toBeNull();
  await act(async () => { preview().click(); });
  expect(playbackRequests).toBe(2);
  expect(container.querySelector("audio")!.getAttribute("src")).toBe("https://audio.test/recovered.mp3");
});

test("an active preview remains reachable when a server search excludes it", async () => {
  globalThis.fetch = mock(async (url) => {
    if (String(url).includes("playback-url")) return Response.json({ url: "https://audio.test/pinned.mp3", durationSec: 2 });
    const request = new URL(String(url), "http://localhost");
    return Response.json({ assets: request.searchParams.has("search") ? [] : [{ id: "pinned", kind: "music", scope: "curated", title: "Pinned preview", moodTags: [], durationSec: 2, favorited: false }], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  await act(async () => { (container.querySelector('[aria-label="Preview Pinned preview"]') as unknown as HTMLButtonElement).click(); });
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "Other");
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("Pinned preview");
});

test("applying a later track cannot be undone by an earlier playback URL response", async () => {
  const applied: (string | null)[] = [];
  studio.setStudioEdits.mockImplementation((update) => {
    const next = (update as (edits: typeof studio.studioEdits) => typeof studio.studioEdits)(studio.studioEdits);
    applied.push(next.music.assetId);
  });
  let finishFirst: (response: Response) => void = () => { throw new Error("No apply pending"); };
  globalThis.fetch = mock(async (url) => {
    if (String(url).includes("/first/playback-url")) return new Promise<Response>((resolve) => { finishFirst = resolve; });
    if (String(url).includes("/second/playback-url")) return Response.json({ url: "https://audio.test/second.mp3", durationSec: 2 });
    return Response.json({ assets: ["first", "second"].map((id) => ({ id, kind: "music", scope: "curated", title: id, moodTags: [], durationSec: 2, favorited: false })), moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  await act(async () => { (container.querySelector('[aria-label="Use first"]') as unknown as HTMLButtonElement).click(); });
  await act(async () => { (container.querySelector('[aria-label="Use second"]') as unknown as HTMLButtonElement).click(); });
  await act(async () => { finishFirst(Response.json({ url: "https://audio.test/first.mp3", durationSec: 2 })); });
  expect(applied).toEqual(["second"]);
});

test.each(["music", "sfx"] as const)("%s lists the Project's brand tracks first and not again in the library", async (kind) => {
  const brandId = "b2f1b0c4-7a33-4c25-9d54-1ef3a8c1a001";
  const track = { assetId: brandId, title: "Brand theme", durationSec: 30 };
  studio.brandAudio = kind === "music" ? { music: [track], sfx: [] } : { music: [], sfx: [track] };
  if (kind === "music") studio.studioEdits = studioEditsSchema.parse({ music: { assetId: brandId, title: "Brand theme" } });
  globalThis.fetch = mock(async (url) => {
    if (String(url).includes("playback-url")) return Response.json({ url: "https://audio.test/brand.mp3", durationSec: 30 });
    const asks = new URL(String(url), "http://localhost").searchParams.get("kind");
    return Response.json({ assets: [
      { id: "library-track", kind: asks, scope: "curated", title: "Library track", moodTags: [], durationSec: 2, favorited: false },
      { id: brandId, kind: asks, scope: "user", title: "Brand theme", moodTags: [], durationSec: 30, favorited: false },
    ], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  if (kind === "sfx") {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Sound effects")!;
    await act(async () => { (tab as unknown as HTMLButtonElement).click(); });
  }
  const text = container.textContent ?? "";
  expect(text.indexOf("Brand")).toBeGreaterThanOrEqual(0);
  expect(text.indexOf("Brand theme")).toBeLessThan(text.indexOf("Library track"));
  expect(text.indexOf("Library")).toBeGreaterThan(text.indexOf("Brand theme"));
  expect(text.split("Brand theme")).toHaveLength(kind === "music" ? 3 : 2);
  expect(container.querySelector('[aria-label="Save Brand theme"]')).toBeNull();
  expect(container.querySelector('[aria-label="Save Library track"]')).not.toBeNull();
  if (kind === "music") {
    // The seeded track shows as the clip's music even though it has no stored URL.
    expect(container.querySelector('[aria-label="Brand theme is in use"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Remove music"]')).not.toBeNull();
  } else {
    expect(container.querySelector('[aria-label="Add Brand theme at playhead"]')).not.toBeNull();
  }
});

test("brand tracks are hidden in category views and follow the search", async () => {
  studio.brandAudio = { music: [{ assetId: "b2f1b0c4-7a33-4c25-9d54-1ef3a8c1a001", title: "Brand theme", durationSec: 30 }], sfx: [] };
  globalThis.fetch = mock(async () => Response.json({ assets: [], moodTags: ["Calm"], nextOffset: null })) as typeof fetch;
  const container = await mount(<MusicPanel />);
  expect(container.textContent).toContain("Brand theme");
  const calm = [...container.querySelectorAll("button")].find((node) => node.textContent === "Calm")!;
  await act(async () => { calm.click(); });
  expect(container.textContent).not.toContain("Brand theme");
});
