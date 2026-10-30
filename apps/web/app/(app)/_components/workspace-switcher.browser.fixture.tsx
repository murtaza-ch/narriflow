import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApiRuntime } from "@narriflow/api-client";

const USER = "user_pending";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const PREVIOUS = "00000000-0000-4000-8000-000000000002";
const browser = new Window({ url: "http://localhost:3000/home" });
const paths: string[] = [];
let runtime: ApiRuntime;
let root: Root | null = null;
const navigations: string[] = [];
let refuseDiscard = false;
const router = { replace: () => undefined, push: (path: string) => navigations.push(path) };
mock.module("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/home" }));
mock.module("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, userId: USER, getToken: async () => "token" }) }));
async function fakeApi(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  paths.push(url.pathname);
  if (refuseDiscard && url.pathname.endsWith("/cancel")) return new Response(JSON.stringify({ error: "workspace_checkout_state_invalid", message: "This workspace must be kept. Open billing to manage its checkout.", requestId: "req_test" }), { status: 409, headers: { "Content-Type": "application/json" } });
  const body = url.pathname.endsWith("/cancel") ? { canceled: true } :
    url.pathname.endsWith("/resume") ? { checkoutUrl: "https://checkout.stripe.com/resumed" } : { workspace: { id: PREVIOUS } };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
beforeAll(() => {
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
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
    fetch: fakeApi,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  process.env.NEXT_PUBLIC_API_URL = "http://api.test";
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

afterAll(async () => {
  await browser.happyDOM.close();
});


async function render(status: "active" | "pending_payment" = "pending_payment", activeId = WORKSPACE) {
  const [{ ChakraProvider }, { system }, { ApiProvider, useApiRuntime }, { WorkspaceSwitcher }, { rememberCheckoutWorkspace }] = await Promise.all([
    import("@chakra-ui/react"), import("@narriflow/ui/theme"), import("../../_components/api-provider"),
    import("./workspace-switcher"), import("../../../lib/pending-workspace-checkout"),
  ]);
  const items = [
    { id: WORKSPACE, name: "Business", role: "owner" as const, status, isPersonal: false, avatarUrl: null },
    { id: PREVIOUS, name: "Previous", role: "owner" as const, status: "active" as const, isPersonal: true, avatarUrl: null },
  ];
  function Harness() {
    runtime = useApiRuntime();
    useEffect(() => { runtime.selectWorkspace(activeId); }, []);
    return <WorkspaceSwitcher activeWorkspaceId={activeId} items={items} presentation={{ tier: "free", canManageApi: false, canInvite: false, planAction: null }} />;
  }
  rememberCheckoutWorkspace(USER, WORKSPACE, PREVIOUS);
  paths.length = 0;
  navigations.length = 0;
  refuseDiscard = false;
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => { root?.render(<ChakraProvider value={system}><ApiProvider><Harness /></ApiProvider></ChakraProvider>); });
  await settle();
  return container;
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); }); }

test("Discard asks inline before removing the purchase and restores the previous Workspace", async () => {
  const container = await render();
  expect(container.textContent).toContain("Payment pending");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(paths).toEqual([]);
  const cancel = [...container.querySelectorAll("button")].find((button) => button.textContent === "Discard workspace");
  expect(cancel).toBeDefined();
  await act(async () => { cancel!.click(); });
  await settle();
  expect(paths).toEqual([]);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("Discard Business and close its unpaid checkout?");
  const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent === "Confirm discard");
  await act(async () => { confirm!.click(); });
  await settle();
  expect(paths).toEqual(["/api/workspaces/business-checkout/cancel", "/api/session/workspace-selection"]);
  expect(runtime.scope.snapshot().workspaceId).toBe(PREVIOUS);
});

test("Resume checkout reuses the pending Workspace and opens its hosted checkout", async () => {
  const container = await render();
  const resume = [...container.querySelectorAll("button")].find((button) => button.textContent === "Resume checkout");
  await act(async () => { resume!.click(); });
  await settle();
  expect(paths).toEqual(["/api/workspaces/business-checkout/resume"]);
  expect(runtime.scope.snapshot().workspaceId).toBe(WORKSPACE);
  expect(browser.location.href).toBe("https://checkout.stripe.com/resumed");
});

test("paid workspaces have no pending hint or cancellation controls", async () => {
  const container = await render("active");
  expect(container.textContent).not.toContain("Payment pending");
  expect(container.textContent).not.toContain("Resume checkout");
  expect(container.textContent).not.toContain("Cancel");
});

test("a completed checkout refusal replaces discard with a billing recovery action", async () => {
  const container = await render();
  refuseDiscard = true;
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
  await act(async () => { button("Discard workspace").click(); });
  await settle();
  await act(async () => { button("Confirm discard").click(); });
  await settle();
  expect(container.textContent).toContain("Open billing");
  expect(container.textContent).not.toContain("Confirm discard");
  expect(container.textContent).not.toContain("Discard workspace");
  await act(async () => { button("Open billing").click(); });
  expect(navigations).toEqual(["/settings/billing"]);
});

