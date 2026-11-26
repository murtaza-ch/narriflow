import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { type BrandTemplateInput, type BrandTemplateSummary, type BrandTitle, DEFAULT_BRAND_TITLE, DEFAULT_CAPTION_PRESET, type StudioTextLayer } from "@narriflow/validators";
import type { BrandApiValue } from "./brand-api";

const browser = new Window({ url: "http://localhost:3000/brand-kit/styles/1" });

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), notFound: () => {} }));
// The real painter measures with a 2D canvas, which happy-dom lacks: the preview records the layer it would draw.
mock.module("@/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/text-layer-sample", () => ({
  TextLayerFramePreview: ({ layer }: { layer: StudioTextLayer }) => <div data-title-preview={JSON.stringify(layer)} />,
}));

// The caption sample plays video frames; it is not what these tests are about.
mock.module("@/app/(app)/_shared/caption-preset-preview", () => ({
  CaptionPresetPreview: () => <div />,
  CaptionSamplePreview: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const template: BrandTemplateSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000001",
  name: "My style",
  isBuiltIn: false,
  builtInKey: null,
  captionPreset: DEFAULT_CAPTION_PRESET,
  logoStorageKey: null,
  logoPosition: "bot-right",
  logoOpacity: 80,
  logoScalePct: 15,
  primaryColor: "#FFFFFF",
  secondaryColor: "#00FF88",
  accentColor: null,
  title: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

/** What the server stores: every saved input, applied to the template as the update route does. */
const saves: BrandTemplateInput[] = [];
let stored = template;

function brandApi(): BrandApiValue {
  const queryClient = new QueryClient();
  return {
    scope: { userId: "user_1", workspaceId: "20000000-0000-4000-8000-000000000001" },
    queries: { templateLogoUrl: (id: string) => ({ queryKey: ["logo", id], queryFn: async () => ({ url: null }) }) },
    mutations: {
      updateTemplate: async (_id: string, input: BrandTemplateInput) => {
        saves.push(input);
        stored = { ...stored, ...input, title: input.title ?? null };
        return stored;
      },
      createTemplate: async (input: BrandTemplateInput) => {
        saves.push(input);
        return { ...template, ...input, title: input.title ?? null };
      },
    },
    queryClient,
    invalidate: async () => {},
    createIntent: () => ({ keyFor: () => "key", complete: () => {} }),
  } as unknown as BrandApiValue;
}

let TemplateForm: typeof import("./template-form").TemplateForm;
let BrandApiContext: typeof import("./brand-api").BrandApiContext;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let QueryClientProvider: typeof import("@tanstack/react-query").QueryClientProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root;

beforeAll(async () => {
  Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement, Element: browser.Element, Node: browser.Node, Event: browser.Event,
    MouseEvent: browser.MouseEvent, KeyboardEvent: browser.KeyboardEvent, PointerEvent: browser.PointerEvent,
    MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
    CSS: browser.CSS, getComputedStyle: browser.getComputedStyle.bind(browser), matchMedia: browser.matchMedia.bind(browser),
    requestAnimationFrame: (cb: FrameRequestCallback) => browser.setTimeout(() => cb(0), 0),
    cancelAnimationFrame: (id: number) => browser.clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true,
  });
  ({ TemplateForm } = await import("./template-form"));
  ({ BrandApiContext } = await import("./brand-api"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ QueryClientProvider } = await import("@tanstack/react-query"));
  ({ system } = await import("@narriflow/ui/theme"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  browser.document.body.replaceChildren();
  saves.length = 0;
  stored = template;
});
afterAll(() => browser.close());

async function mount(initialTemplate: BrandTemplateSummary | undefined, mode: "create" | "edit" = "edit") {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  const api = brandApi();
  await act(async () => {
    root.render(
      <ChakraProvider value={system}>
        <QueryClientProvider client={api.queryClient}>
          <BrandApiContext.Provider value={api}>
            <TemplateForm mode={mode} initialTemplate={initialTemplate} cancelHref="/brand-kit" />
          </BrandApiContext.Provider>
        </QueryClientProvider>
      </ChakraProvider>,
    );
  });
  return container as unknown as HTMLElement;
}

const settle = async () => act(async () => { await browser.happyDOM.waitUntilComplete(); });
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error("nothing to click");
  await act(async () => (element as unknown as HTMLElement).click());
  await settle();
};
const byLabel = (dom: HTMLElement, label: string) => dom.querySelector(`[aria-label="${label}"]`);
const button = (dom: HTMLElement, text: string) => [...dom.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
/** A segmented control's option: its hidden radio, by the group's label and the option's text. */
const segment = (dom: HTMLElement, group: string, text: string) =>
  [...(byLabel(dom, group)?.querySelectorAll("label") ?? [])].find((node) => node.textContent?.trim() === text)?.querySelector("input");
const checkedSegment = (dom: HTMLElement, group: string) =>
  [...(byLabel(dom, group)?.querySelectorAll("label") ?? [])].find((node) => node.querySelector("input")?.checked)?.textContent?.trim();
const titleSwitch = (dom: HTMLElement) =>
  [...dom.querySelectorAll("label")].find((node) => node.textContent?.includes("Add the clip title to new clips"))?.querySelector("input") as HTMLInputElement | undefined;
const preview = (dom: HTMLElement): StudioTextLayer | null => {
  const node = dom.querySelector("[data-title-preview]");
  return node ? JSON.parse(node.getAttribute("data-title-preview")!) : null;
};
const savedTitle = (): BrandTitle => {
  const title = saves.at(-1)?.title;
  if (!title) throw new Error("no title saved");
  return title;
};

test("a template without title settings shows the built-in default, labelled apart from captions", async () => {
  const dom = await mount(template);
  expect(dom.textContent).toContain("Caption look");
  expect(dom.textContent).toContain("Caption text");
  expect(titleSwitch(dom)?.checked).toBe(true);
  expect(checkedSegment(dom, "Title display duration")).toBe("5 s");
  expect(checkedSegment(dom, "Title position")).toBe("Top");
  expect(byLabel(dom, "Bold")?.getAttribute("aria-pressed")).toBe("true");
  expect(byLabel(dom, "Remove background")).not.toBeNull();
  // The phone preview draws the default title at its place and in its style.
  expect(preview(dom)).toMatchObject({ role: "title", positionY: DEFAULT_BRAND_TITLE.positionY, style: DEFAULT_BRAND_TITLE.style });
}, 30_000);

test("an untouched title saves as the built-in default (null)", async () => {
  const dom = await mount(template);
  await click(button(dom, "Save changes"));
  expect(saves).toHaveLength(1);
  expect(saves[0]?.title).toBeNull();
}, 30_000);

test("a changed title style is saved through the update mutation and shows again on reload", async () => {
  const dom = await mount(template);
  await click(byLabel(dom, "Bold"));
  await click(byLabel(dom, "Uppercase"));
  await click(byLabel(dom, "Remove background"));
  await click(byLabel(dom, "Add stroke"));
  await click(segment(dom, "Title position", "Bottom"));
  await click(segment(dom, "Title display duration", "Whole clip"));
  expect(preview(dom)).toMatchObject({ positionY: 80, endSec: null, style: { bold: false, textCase: "uppercase", background: null } });
  await click(button(dom, "Save changes"));

  const title = savedTitle();
  expect(title).toMatchObject({ enabled: true, durationSec: null, positionY: 80, style: { bold: false, textCase: "uppercase", background: null, stroke: { color: "#000000", width: 4 } } });
  // Everything else about the style is the default title's.
  expect(title.style.font).toBe(DEFAULT_BRAND_TITLE.style.font);
  expect(title.style.color).toBe(DEFAULT_BRAND_TITLE.style.color);

  await act(async () => root.unmount());
  browser.document.body.replaceChildren();
  const reloaded = await mount(stored);
  expect(byLabel(reloaded, "Bold")?.getAttribute("aria-pressed")).toBe("false");
  expect(byLabel(reloaded, "Uppercase")?.getAttribute("aria-pressed")).toBe("true");
  expect(byLabel(reloaded, "Add background")).not.toBeNull();
  expect(byLabel(reloaded, "Remove stroke")).not.toBeNull();
  expect(checkedSegment(reloaded, "Title position")).toBe("Bottom");
  expect(checkedSegment(reloaded, "Title display duration")).toBe("Whole clip");
}, 30_000);

test("switching the title off keeps its style and duration; the preview draws no title", async () => {
  const dom = await mount(template);
  await click(segment(dom, "Title display duration", "10 s"));
  await click(byLabel(dom, "Italic"));
  await click(titleSwitch(dom));
  expect(dom.textContent).toContain("New clips open without a title");
  expect(byLabel(dom, "Italic")).toBeNull();
  expect(preview(dom)).toBeNull();
  await click(button(dom, "Save changes"));
  expect(savedTitle()).toMatchObject({ enabled: false, durationSec: 10, style: { italic: true } });

  await click(titleSwitch(dom));
  expect(checkedSegment(dom, "Title display duration")).toBe("10 s");
  expect(byLabel(dom, "Italic")?.getAttribute("aria-pressed")).toBe("true");
}, 30_000);

test("custom seconds and a stored position the form did not set", async () => {
  const custom: BrandTitle = { ...DEFAULT_BRAND_TITLE, durationSec: 42, positionY: 30 };
  const dom = await mount({ ...template, title: custom });
  expect(checkedSegment(dom, "Title display duration")).toBe("Custom");
  expect((byLabel(dom, "Title display duration in seconds") as HTMLInputElement | null)?.value).toBe("42");
  expect(checkedSegment(dom, "Title position")).toBe("Custom");
  await click(segment(dom, "Title position", "Middle"));
  expect(preview(dom)?.positionY).toBe(50);
  // The stored value stays one tap away.
  await click(segment(dom, "Title position", "Custom"));
  expect(preview(dom)?.positionY).toBe(30);
  await click(button(dom, "Save changes"));
  expect(savedTitle()).toMatchObject({ durationSec: 42, positionY: 30 });
}, 30_000);

test("a new style starts with the built-in title and saves it through the create mutation", async () => {
  const dom = await mount(undefined, "create");
  expect(titleSwitch(dom)?.checked).toBe(true);
  await click(byLabel(dom, "Align left"));
  await click(button(dom, "Create style"));
  expect(savedTitle().style.align).toBe("left");
}, 30_000);
