import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const browser = new Window({ url: "http://localhost:3000/review/private-token" });
let ReviewClient: typeof import("./review-client").ReviewClient;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root | null = null;

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

async function renderReview() {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root?.render(
      <ChakraProvider value={system}>
        <ReviewClient token="private-token" />
      </ChakraProvider>,
    );
    await browser.happyDOM.waitUntilComplete();
  });
  return container;
}

function enter(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new browser.InputEvent("input", { bubbles: true, data: value }));
}

beforeAll(async () => {
  installBrowserGlobals();
  ({ ReviewClient } = await import("./review-client"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ system } = await import("@narriflow/ui/theme"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
});

afterAll(() => browser.close());

describe("guest review browser contract", () => {
  test("labels access fields and focuses an inline access failure", async () => {
    let focusedRole: string | null = null;
    const originalFocus = browser.HTMLElement.prototype.focus;
    browser.HTMLElement.prototype.focus = function focus(options?: FocusOptions) {
      focusedRole = this.getAttribute("role");
      originalFocus.call(this, options);
    };
    globalThis.fetch = mock(async (_input, init) => init?.method === "POST"
      ? Response.json({ message: "That passcode is not valid." }, { status: 403 })
      : Response.json({ message: "Access required." }, { status: 401 })) as unknown as typeof fetch;
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
    globalThis.fetch = mock(async () => Response.json({
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
    })) as unknown as typeof fetch;
    const container = await renderReview();
    const video = container.querySelector("video") as HTMLVideoElement;

    expect(container.querySelector("h1")?.textContent).toBe("Existing project footage");
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Opening clip");
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-label")).toBe("Opening clip");
    expect(video.controls).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.getAttribute("aria-label")).toContain("submitted export");
    expect(container.querySelector('textarea[aria-label="Review comment"]')).not.toBeNull();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Clip feedback"))).toBe(true);
  });
});
