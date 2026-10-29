import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { UpgradeBillingMode } from "./upgrade";
import type { ReviewRoomData, ReviewRound } from "../projects/[projectId]/review-panel";

const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({ ...navigation, useRouter: () => ({ refresh() {} }) }));
mock.module("./account-menu", () => ({ AccountAvatar: () => <span /> }));
// The review surfaces read through the real API provider; only Clerk and HTTP are controlled.
const USER = "user_upgrade";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
mock.module("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, userId: USER, getToken: async () => "session-token" }) }));
process.env.NEXT_PUBLIC_API_URL = "https://api.test";

const browser = new Window({ url: "http://localhost:3000/home" });

let LockedButton: typeof import("./upgrade").LockedButton;
let UpgradeProvider: typeof import("./upgrade").UpgradeProvider;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let ApiProvider: typeof import("@/app/_components/api-provider").ApiProvider;
let ReviewPanel: typeof import("../projects/[projectId]/review-panel").ReviewPanel;
let ProjectShareButton: typeof import("../projects/[projectId]/project-share-button").ProjectShareButton;
let root: Root | null = null;
let createRoot: typeof import("react-dom/client").createRoot;
const realFetch = globalThis.fetch;

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
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      browser.setTimeout(() => callback(browser.performance.now()), 0),
    cancelAnimationFrame: (handle: number) => browser.clearTimeout(handle),
    getComputedStyle: browser.getComputedStyle.bind(browser),
    CSS: browser.CSS,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
}

/** Mounts the provider with one locked Pro action and clicks it open. */
async function openProDialog({
  billingMode,
  canManageBilling,
}: { billingMode: UpgradeBillingMode; canManageBilling: boolean }) {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root?.render(
      <ChakraProvider value={system}>
        <UpgradeProvider currentTier="creator" billingMode={billingMode} canManageBilling={canManageBilling}>
          <LockedButton prompt={{ tier: "pro", headline: "Upgrade to export a bundle" }}>Export bundle</LockedButton>
        </UpgradeProvider>
      </ChakraProvider>,
    );
  });
  const trigger = container.querySelector("button");
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.click();
    await browser.happyDOM.waitUntilComplete();
  });
  return browser.document.querySelector('[role="dialog"]');
}

beforeAll(async () => {
  installBrowserGlobals();
  ({ createRoot } = await import("react-dom/client"));
  ({ LockedButton, UpgradeProvider } = await import("./upgrade"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ system } = await import("@narriflow/ui/theme"));
  ({ ApiProvider } = await import("@/app/_components/api-provider"));
  ({ ReviewPanel } = await import("../projects/[projectId]/review-panel"));
  ({ ProjectShareButton } = await import("../projects/[projectId]/project-share-button"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
  globalThis.fetch = realFetch;
  browser.localStorage.clear();
});

beforeEach(() => {
  browser.localStorage.setItem(`narriflow:workspace:${USER}`, WORKSPACE);
});

const room: ReviewRoomData = {
  project: { title: "Interview", workspace: { name: "Studio" }, approvalRequiredByDefault: false },
  candidates: [{ id: "clip", title: "Opening", editorRevision: 1, exports: [{
    id: "export", editorRevision: 1, createdAt: "2026-10-01T00:00:00Z",
    variants: [{ id: "variant", aspectRatio: "ratio_9_16", durationSec: 30 }],
  }] }],
  rounds: [],
};
const round: ReviewRound = {
  id: "round", revision: 1, title: "First review", message: null, status: "open", path: "/review/token",
  allowDownloads: false, approvalRequired: false, recipientEmails: [], sentAt: "2026-10-01T00:00:00Z",
  expiresAt: null, revokedAt: null, decision: null, newerWorkAvailable: false,
  items: [], comments: [], guests: [], auditEvents: [], notifications: [], context: [],
};
const refusal = {
  error: "plan_feature_required", message: "Client review rooms need the Business plan.",
  details: { currentTier: "pro", requiredTier: "business", feature: "review.rooms" },
};

async function renderReview(node: React.ReactNode, currentTier: "business" | "creator" = "business") {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => root?.render(
    <ChakraProvider value={system}>
      <ApiProvider>
        <UpgradeProvider currentTier={currentTier} billingMode="change_plan" canManageBilling>{node}</UpgradeProvider>
      </ApiProvider>
    </ChakraProvider>,
  ));
}

async function clickReviewButton(name: string) {
  const button = [...browser.document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name);
  expect(button).toBeDefined();
  await act(async () => { button!.click(); await browser.happyDOM.waitUntilComplete(); });
}

describe("review refusals", () => {
  test("sending from a locked plan opens the dialog without a mutation", async () => {
    let writes = 0;
    globalThis.fetch = (async () => { writes++; return Response.json({}); }) as typeof fetch;
    await renderReview(<ReviewPanel projectId="project" initialData={room} canManage preselection={{
      selections: { clip: { exportId: "export", variantIds: ["variant"], required: true } }, dropped: 0,
    }} />, "creator");
    const send = [...browser.document.querySelectorAll("button")].find((item) => item.textContent?.includes("Send round with"))!;
    expect(send.getAttribute("aria-haspopup")).toBe("dialog");
    await act(async () => { send.click(); await browser.happyDOM.waitUntilComplete(); });
    expect(browser.document.querySelector('[role="dialog"]')?.textContent).toContain("Upgrade to share projects for client review");
    expect(writes).toBe(0);
  });

  test("a permission refusal remains an error with no purchase offer", async () => {
    globalThis.fetch = (async () => Response.json({ error: "capability_required", message: "You cannot manage reviews." }, { status: 403 })) as typeof fetch;
    await renderReview(<ReviewPanel projectId="project" initialData={room} canManage preselection={{
      selections: { clip: { exportId: "export", variantIds: ["variant"], required: true } }, dropped: 0,
    }} />);
    await clickReviewButton("Send round with 1 clip");
    expect(browser.document.querySelector('[role="dialog"]')).toBeNull();
    expect(browser.document.querySelector('[role="alert"]')?.textContent).toContain("You cannot manage reviews.");
  });

  test("a refused round opens the shared dialog and keeps the selected exports and draft", async () => {
    let writes = 0;
    globalThis.fetch = (async () => { writes++; return Response.json(refusal, { status: 402 }); }) as typeof fetch;
    await renderReview(<ReviewPanel projectId="project" initialData={room} canManage preselection={{
      selections: { clip: { exportId: "export", variantIds: ["variant"], required: true } }, dropped: 0,
    }} />);
    const title = browser.document.querySelector<HTMLInputElement>("#review-title")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(title, "Client draft");
      title.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await clickReviewButton("Send round with 1 clip");
    expect(browser.document.querySelector('[role="dialog"]')?.textContent).toContain(refusal.message);
    expect(title.value).toBe("Client draft");
    expect(browser.document.querySelector('[aria-label="Include Opening"]')?.getAttribute("data-state")).toBe("checked");
    expect(writes).toBe(1);
  });

  for (const action of ["create", "invite"] as const) {
    test(`a refused share ${action} keeps recipients and opens a plan-specific dialog`, async () => {
      let writes = 0;
      globalThis.fetch = (async (_url, init) => {
        if (init?.method === "POST") { writes++; return Response.json(refusal, { status: 402 }); }
        return Response.json({ ...room, rounds: action === "invite" ? [round] : [] });
      }) as typeof fetch;
      await renderReview(<ProjectShareButton projectId="project" upgrade={null} actor={{
        name: "Owner", email: null, imageUrl: null, initials: "O", role: "owner",
      }} />);
      await clickReviewButton("Share");
      const input = browser.document.querySelector<HTMLInputElement>('[aria-label="Reviewer email addresses"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "client@example.com");
        input.dispatchEvent(new browser.Event("input", { bubbles: true }));
      });
      await clickReviewButton(action === "invite" ? "Invite" : "Create review link");
      expect([...browser.document.querySelectorAll('[role="dialog"]')].at(-1)?.textContent).toContain(refusal.message);
      expect(input.value).toBe("client@example.com");
      expect(writes).toBe(1);
    });
  }
});

afterAll(() => browser.close());

describe("upgrade dialog", () => {
  test("checkout mode offers Annual and Monthly and hands the interval to billing", async () => {
    const dialog = await openProDialog({ billingMode: "checkout", canManageBilling: true });
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Upgrade to export a bundle");
    const group = dialog?.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group?.textContent).toContain("Annual");
    expect(group?.textContent).toContain("Monthly");
    const cta = dialog?.querySelector('a[href^="/settings/billing"]');
    expect(cta?.getAttribute("href")).toBe("/settings/billing?plan=pro&interval=annual#plans");
    expect(cta?.textContent).toBe("Upgrade to Pro");
  });

  test("choosing Monthly changes the billing handoff", async () => {
    const dialog = await openProDialog({ billingMode: "checkout", canManageBilling: true });
    const monthly = [...(dialog?.querySelectorAll("label") ?? [])].find((label) =>
      label.textContent?.includes("Monthly"),
    );
    expect(monthly).toBeDefined();
    await act(async () => {
      (monthly?.querySelector("input") ?? monthly)?.click();
      await browser.happyDOM.waitUntilComplete();
    });
    expect(dialog?.querySelector('a[href^="/settings/billing"]')?.getAttribute("href")).toBe(
      "/settings/billing?plan=pro&interval=monthly#plans",
    );
  });

  test("paid plan mode links to the quote review in billing", async () => {
    const dialog = await openProDialog({ billingMode: "change_plan", canManageBilling: true });
    expect(dialog?.querySelector('[role="radiogroup"]')).toBeNull();
    const cta = dialog?.querySelector('a[href^="/settings/billing"]');
    expect(cta?.textContent).toBe("Switch to Pro");
    expect(dialog?.textContent).toContain("Review the amount and timing in billing.");
    expect(cta?.getAttribute("href")).toBe("/settings/billing?plan=pro#plans");
  });

  test("anyone but the owner is told whom to ask and gets no purchase link", async () => {
    const dialog = await openProDialog({ billingMode: "checkout", canManageBilling: false });
    expect(dialog?.textContent).toContain("Only the workspace owner can change the plan");
    expect(dialog?.querySelector('a[href^="/settings/billing"]')).toBeNull();
  });
});
