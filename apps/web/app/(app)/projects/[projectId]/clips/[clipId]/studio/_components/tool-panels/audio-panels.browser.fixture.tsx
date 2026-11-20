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
  selectedMusicBlockId: null as string | null,
  selectMusicBlock: mock((_id: string) => {}),
  deselectMusicBlock: mock(() => {}),
  compositeToBaseEdited: (timeSec: number) => timeSec,
  editedTimeMap: { editedDurationSec: 60 },
};
mock.module("../studio-shell", () => ({ useStudio: () => studio }));

// The audio helpers call the Brand API through the shared runtime. Requests go to
// an absolute API origin with a Bearer token and reach the per-test `globalThis.fetch`.
const apiRuntime = createApiRuntime({
  baseUrl: "https://api.test",
  getToken: async () => "token",
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
});
// A failed read reports at once instead of backing off, and no test sees another's cache.
apiRuntime.queryClient.setDefaultOptions({ queries: { retry: false } });
apiRuntime.setIdentity("user_1");
apiRuntime.selectWorkspace("ws_1");
const workspaceScope = { userId: "user_1", workspaceId: "ws_1" };
mock.module("../../../../../../../../_components/api-provider", () => ({
  useApiRuntime: () => apiRuntime,
  useWorkspaceScope: () => workspaceScope,
}));

// The list asks for the next page when its end sentinel comes into view.
const observers = new Set<{ callback: IntersectionObserverCallback; target: Element | null }>();
class FakeIntersectionObserver {
  readonly entry = { callback: undefined as unknown as IntersectionObserverCallback, target: null as Element | null };
  constructor(callback: IntersectionObserverCallback) {
    this.entry.callback = callback;
  }
  observe(target: Element) {
    this.entry.target = target;
    observers.add(this.entry);
  }
  disconnect() {
    observers.delete(this.entry);
  }
  unobserve() {}
  takeRecords() { return []; }
}
/** Brings every observed list end into view, as scrolling to the bottom does. */
async function scrollToEnd() {
  await act(async () => {
    for (const { callback, target } of [...observers]) {
      callback([{ isIntersecting: true, target } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
    await Bun.sleep(20);
  });
}
const settle = () => act(async () => { await Bun.sleep(20); });
const listRow = (overrides: Record<string, unknown>) => ({
  scope: "curated", moodTags: [], durationSec: 2, favorited: false,
  previewUrl: null, artist: null, license: null, attribution: null, ...overrides,
});

let UploadsTab: typeof import("./uploads-tab").UploadsTab;
let MusicPanel: typeof import("./music-panel").MusicPanel;
let usePrefetchAudioLibrary: typeof import("./audio-library").usePrefetchAudioLibrary;
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
    IntersectionObserver: FakeIntersectionObserver,
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
  ({ usePrefetchAudioLibrary } = await import("./audio-library"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
  globalThis.fetch = realFetch;
  observers.clear();
  apiRuntime.queryClient.clear();
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
  await settle();
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
  let listRequests = 0;
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
    else listRequests++;
    return Response.json({ assets: [], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<UploadsTab />);
  const listedBefore = listRequests;
  const input = container.querySelector('input[type="file"]')!;
  const file = new File(["audio"], filename, { type: reported });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  expect(presignBody).toEqual({ contentType: expected, sizeBytes: 5 });
  expect(uploadedContentType).toBe(expected);
  expect(finalizeBody).toEqual({ key: "audio/track", kind: "music", title: "Track", durationSec: 2, sizeBytes: 5 });
  // The finished upload makes the cached lists stale, so they are read again.
  await settle();
  expect(listRequests).toBeGreaterThan(listedBefore);
});

test("an unsupported MIME and extension never request an upload grant", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (_url, init) => {
    requests.push(init?.method ?? "GET");
    return Response.json({ assets: [], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<UploadsTab />);
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
    ? <UploadsTab />
    : <MusicPanel />);
  if (view === "sfx") {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Sound effects")!;
    await act(async () => { (tab as unknown as HTMLButtonElement).click(); });
    await settle();
  }
  expect(container.textContent).toContain("Couldn't load");
  const retry = [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
  expect(retry).toBeDefined();
  await act(async () => { retry!.click(); });
  await settle();
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
    await settle();
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


test.each(["music", "sfx", "uploads"] as const)("%s loads the next page when the end scrolls into view and retries a failed page", async (view) => {
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
    return Response.json({ assets: [listRow({
      id: `${kind}-${offset}`, kind, scope: "user", title: `${offset ? "Second" : "First"} ${kind}`,
    })], moodTags: [], nextOffset: offset === 0 ? 1 : null });
  }) as typeof fetch;
  const container = await mount(view === "uploads" ? <UploadsTab /> : <MusicPanel />);
  if (view === "sfx") {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Sound effects")!;
    await act(async () => { (tab as unknown as HTMLButtonElement).click(); });
    await settle();
  }
  const kind = view === "sfx" ? "sfx" : "music";
  expect(container.textContent).toContain(`First ${kind}`);
  // There is no Load more button: reaching the end asks for the next page.
  expect([...container.querySelectorAll("button")].some((node) => node.textContent === "Load more")).toBe(false);
  await scrollToEnd();
  expect(container.textContent).toContain(`First ${kind}`);
  expect(container.textContent).toContain("Couldn't load");
  const retry = [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
  expect(retry).toBeDefined();
  await act(async () => { retry!.click(); await Bun.sleep(20); });
  expect(container.textContent).toContain(`Second ${kind}`);
  expect(container.textContent).not.toContain("Couldn't load");
  // Nothing more to load: the end is no longer watched.
  expect(observers.size).toBe(0);
  if (view === "uploads") expect(requests.every((url) => url.searchParams.get("scope") === "user")).toBe(true);
  expect(requests.every((url) => url.searchParams.get("limit") === "40")).toBe(true);
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

test.each(["music", "sfx"] as const)("%s searches the server after a pause, from page one, without a spinner or an older page", async (kind) => {
  const requests: URL[] = [];
  let finishSearch: (response: Response) => void = () => { throw new Error("No search pending"); };
  const page = (title: string, nextOffset: number | null) => Response.json({ assets: [listRow({
    id: title, kind, title, moodTags: ["Calm"], favorited: true,
  })], moodTags: ["Calm"], nextOffset });
  globalThis.fetch = mock(async (url) => {
    const request = new URL(String(url), "http://localhost");
    requests.push(request);
    if (request.searchParams.get("search")) return new Promise<Response>((resolve) => { finishSearch = resolve; });
    return page("Earlier track", null);
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  if (kind === "sfx") {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Sound effects")!;
    await act(async () => { (tab as unknown as HTMLButtonElement).click(); });
    await settle();
  }
  const input = container.querySelector("input")!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await type("Nee");
  await type("Needle");
  const before = requests.length;
  // Debounced: nothing is asked while typing.
  await settle();
  expect(requests.length).toBe(before);
  await act(async () => { await Bun.sleep(260); });
  expect(requests.length).toBe(before + 1);
  expect(requests.at(-1)!.searchParams.get("offset")).toBe("0");
  expect(requests.at(-1)!.searchParams.get("search")).toBe("Needle");
  // While the server answers, the previous rows stay (narrowed locally) and no skeleton shows.
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => { finishSearch(page("Needle match", null)); await Bun.sleep(20); });
  expect(container.textContent).toContain("Needle match");
  expect(container.textContent).not.toContain("Earlier track");
  const saved = [...container.querySelectorAll("button")].find((node) => node.textContent === "Saved")!;
  await act(async () => { saved.click(); await Bun.sleep(260); });
  expect(requests.at(-1)!.searchParams.get("favorited")).toBe("true");
  expect(requests.at(-1)!.searchParams.get("search")).toBe("Needle");
  const calm = [...container.querySelectorAll("button")].find((node) => node.textContent === "Calm")!;
  await act(async () => { calm.click(); await Bun.sleep(20); });
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
    await settle();
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
    applied.push(next.music.blocks[0]?.assetId ?? null);
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
  if (kind === "music") studio.studioEdits = studioEditsSchema.parse({ music: { blocks: [{ id: "bed", assetId: brandId, title: "Brand theme", startSec: 0 }] } });
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
    await settle();
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
    expect(container.querySelector('[aria-label="Remove music block"]')).not.toBeNull();
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

const CREDIT = '"Sneaky Snitch" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0\nhttps://creativecommons.org/licenses/by/4.0/';
const CLASSIC_ID = "5b0f1e5e-3b7c-4c55-8f1e-0a1b2c3d4e51";
const FREE_ID = "5b0f1e5e-3b7c-4c55-8f1e-0a1b2c3d4e52";
const PUBLIC_URL = "https://library.test/audio-library/music/abc.mp3";

test("a curated row previews and applies from its public URL with no API call", async () => {
  const requests: string[] = [];
  const applied: unknown[] = [];
  studio.setStudioEdits.mockImplementation((update) => {
    applied.push((update as (edits: typeof studio.studioEdits) => typeof studio.studioEdits)(studio.studioEdits).music.blocks[0]);
  });
  globalThis.fetch = mock(async (url) => {
    requests.push(String(url));
    return Response.json({ assets: [listRow({
      id: "classic", kind: "music", title: "Sneaky Snitch", artist: "Kevin MacLeod", license: "cc_by_4",
      attribution: CREDIT, previewUrl: PUBLIC_URL, durationSec: 135,
    })], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  // Artwork is a gradient from the id, the duration reads mm:ss, a CC BY row names its artist and hints at the credit.
  const text = container.textContent ?? "";
  expect(text).toContain("2:15");
  expect(text).toContain("Kevin MacLeod");
  expect(text).toContain("Credit");
  expect(container.innerHTML).toContain("linear-gradient(");
  expect(container.querySelector("img")).toBeNull();
  await act(async () => { (container.querySelector('[aria-label="Preview Sneaky Snitch"]') as unknown as HTMLButtonElement).click(); });
  expect(container.querySelector("audio")!.getAttribute("src")).toBe(PUBLIC_URL);
  await act(async () => { (container.querySelector('[aria-label="Use Sneaky Snitch"]') as unknown as HTMLButtonElement).click(); await settle(); });
  expect(applied).toEqual([expect.objectContaining({ assetId: "classic", url: PUBLIC_URL })]);
  expect(requests.some((url) => url.includes("playback-url"))).toBe(false);
});

test("chips follow the curated order with Saved after All", async () => {
  globalThis.fetch = mock(async () => Response.json({ assets: [], moodTags: ["Zesty", "Epic", "Popular", "Chill"], nextOffset: null })) as typeof fetch;
  const container = await mount(<MusicPanel />);
  const chips = [...container.querySelectorAll("button[aria-pressed]")].map((node) => node.textContent);
  expect(chips.slice(0, 6)).toEqual(["All", "Saved", "Popular", "Chill", "Epic", "Zesty"]);
});

test("only the first load shows a skeleton and tab switches reuse the cache", async () => {
  const requests: string[] = [];
  let finish: (response: Response) => void = () => {};
  globalThis.fetch = mock(async (url) => {
    const kind = new URL(String(url), "http://localhost").searchParams.get("kind");
    requests.push(kind!);
    if (requests.length === 1) return new Promise<Response>((resolve) => { finish = resolve; });
    return Response.json({ assets: [listRow({ id: `${kind}-1`, kind, title: `Cached ${kind}` })], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => { finish(Response.json({ assets: [listRow({ id: "music-1", kind: "music", title: "Cached music" })], moodTags: [], nextOffset: null })); await Bun.sleep(20); });
  expect(container.querySelector('[role="status"]')).toBeNull();
  const tab = (name: string) => [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent === name) as unknown as HTMLButtonElement;
  await act(async () => { tab("Sound effects").click(); await Bun.sleep(20); });
  expect(container.textContent).toContain("Cached sfx");
  await act(async () => { tab("Music").click(); });
  // Back on Music: rows paint at once from the cache, with no further request.
  expect(container.textContent).toContain("Cached music");
  expect(container.querySelector('[role="status"]')).toBeNull();
  await settle();
  expect(requests).toEqual(["music", "sfx"]);
});

test("opening the Studio warms the first page of music and effects", async () => {
  const requests: URL[] = [];
  globalThis.fetch = mock(async (url) => {
    const request = new URL(String(url), "http://localhost");
    requests.push(request);
    const kind = request.searchParams.get("kind");
    return Response.json({ assets: [listRow({ id: `${kind}-1`, kind, title: `Warm ${kind}` })], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  function Prefetch() { usePrefetchAudioLibrary(); return null; }
  await mount(<Prefetch />);
  expect(requests.map((url) => url.searchParams.get("kind")).sort()).toEqual(["music", "sfx"]);
  expect(requests.every((url) => url.searchParams.get("limit") === "40" && url.searchParams.get("offset") === "0" && !url.searchParams.has("search") && !url.searchParams.has("mood"))).toBe(true);
  await act(async () => { root?.unmount(); });
  root = null;
  browser.document.body.replaceChildren();
  const container = await mount(<MusicPanel />);
  expect(container.textContent).toContain("Warm music");
  expect(requests).toHaveLength(2);
});

test("a background refetch that ends re-arms the end of the list", async () => {
  let releaseRefetch: (response: Response) => void = () => {};
  let calls = 0;
  const page = (offset: number) => Response.json({
    assets: [listRow({ id: `music-${offset}`, kind: "music", scope: "user", title: `Page ${offset}` })],
    moodTags: [], nextOffset: offset < 2 ? offset + 1 : null,
  });
  globalThis.fetch = mock(async (url) => {
    const offset = Number(new URL(String(url), "http://localhost").searchParams.get("offset") ?? 0);
    calls++;
    // The second request is a refetch of page one, held open while the end comes into view.
    if (calls === 2) return new Promise<Response>((resolve) => { releaseRefetch = resolve; });
    return page(offset);
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  expect(container.textContent).toContain("Page 0");
  await act(async () => { void apiRuntime.queryClient.invalidateQueries({ queryKey: ["nf", "user_1", "ws_1", "brand"] }); await Bun.sleep(5); });
  // While it is in flight the observer is disarmed, so reaching the end asks for nothing.
  expect(observers.size).toBe(0);
  await act(async () => { releaseRefetch(page(0)); await Bun.sleep(20); });
  // Once it ends the end is watched again and the next page loads.
  expect(observers.size).toBe(1);
  await scrollToEnd();
  expect(container.textContent).toContain("Page 1");
});

test("warming the library leaves an already loaded multi-page list alone", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (url) => {
    requests.push(String(url));
    return Response.json({ assets: [], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const { audioListQuery } = await import("./audio-library");
  const options = audioListQuery({ transport: apiRuntime.transport, scope: workspaceScope }, { kind: "music" });
  const pages = [0, 1, 2].map((n) => ({ assets: [listRow({ id: `m${n}`, kind: "music", title: `M${n}` })], moodTags: [], nextOffset: n < 2 ? n + 1 : null }));
  apiRuntime.queryClient.setQueryData(options.queryKey, { pages, pageParams: [0, 1, 2] });
  function Prefetch() { usePrefetchAudioLibrary(); return null; }
  await mount(<Prefetch />);
  expect((apiRuntime.queryClient.getQueryData(options.queryKey) as { pages: unknown[] }).pages).toHaveLength(3);
  // Only the kind with nothing cached is fetched.
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("kind=sfx");
});

test("saving a track updates the list at once and rolls back when the request fails", async () => {
  let failFavorite = false;
  globalThis.fetch = mock(async (url) => {
    if (String(url).includes("/favorite")) {
      return failFavorite ? new Response(null, { status: 500 }) : Response.json({ ok: true });
    }
    return Response.json({ assets: [listRow({ id: "song", kind: "music", title: "Song" })], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  const star = () => container.querySelector('[aria-label="Save Song"], [aria-label="Remove Song from Saved"]') as unknown as HTMLButtonElement;
  await act(async () => { star().click(); await Bun.sleep(20); });
  expect(star().getAttribute("aria-label")).toBe("Remove Song from Saved");
  failFavorite = true;
  await act(async () => { star().click(); });
  // Optimistic: unsaved before the server answers, restored when it refuses.
  await act(async () => { await Bun.sleep(20); });
  expect(star().getAttribute("aria-label")).toBe("Remove Song from Saved");
});

const playbackBody = (attribution: string | null) => ({ url: PUBLIC_URL, durationSec: 135, attribution });

test("a block that needs a credit shows Credit required and copies the credit line, even when its row is on no loaded page", async () => {
  const copied: string[] = [];
  Object.defineProperty(browser.navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } }, configurable: true });
  studio.studioEdits = studioEditsSchema.parse({ music: { blocks: [{ id: "bed", assetId: CLASSIC_ID, title: "Sneaky Snitch", url: PUBLIC_URL, startSec: 0 }] } });
  const requests: string[] = [];
  globalThis.fetch = mock(async (url) => {
    requests.push(String(url));
    // The list never contains the track: its credit has to come from the per-asset lookup.
    if (String(url).includes("playback-url")) return Response.json(playbackBody(CREDIT));
    return Response.json({ assets: [], moodTags: [], nextOffset: null });
  }) as typeof fetch;
  const container = await mount(<MusicPanel />);
  expect(container.textContent).toContain("Credit required");
  expect(container.textContent).toContain("Paste this into your video description.");
  await act(async () => { (container.querySelector('[aria-label="Copy credit"]') as unknown as HTMLButtonElement).click(); });
  expect(copied).toEqual([CREDIT]);
  expect(requests.filter((url) => url.includes(`${CLASSIC_ID}/playback-url`))).toHaveLength(1);
});

test("a block from a CC0 track owes no credit", async () => {
  studio.studioEdits = studioEditsSchema.parse({ music: { blocks: [{ id: "bed", assetId: FREE_ID, title: "Free", url: PUBLIC_URL, startSec: 0 }] } });
  globalThis.fetch = mock(async (url) => String(url).includes("playback-url")
    ? Response.json(playbackBody(null))
    : Response.json({ assets: [listRow({ id: FREE_ID, kind: "music", title: "Free", license: "cc0" })], moodTags: [], nextOffset: null })) as typeof fetch;
  const container = await mount(<MusicPanel />);
  expect(container.textContent).not.toContain("Credit required");
});
