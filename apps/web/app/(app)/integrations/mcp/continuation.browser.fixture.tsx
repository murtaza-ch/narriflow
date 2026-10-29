import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApiRuntime } from "@narriflow/api-client/core";
import type { McpPreparationData } from "@narriflow/validators/api/integrations";

// Isolated process: real QueryClient/provider/transport and UI, with controlled HTTP.
const browser = new Window({ url: "http://localhost:3000/integrations/mcp" });
const USER = "user_mcp";
const SELECTED = "00000000-0000-4000-8000-000000000001";
const SIGNED = "00000000-0000-4000-8000-000000000002";
const TOKEN = "private-signed-token";
let search = new URLSearchParams();
let root: Root | null = null;
let runtime: ApiRuntime | null = null;
let navigated: string[] = [];
let requests: { url: URL; headers: Headers; init: RequestInit }[] = [];
let refusal: { error: string; message: string; requestId: string; details?: Record<string, unknown> } | null = null;
let lostResponse = false;
let selectedAllowed = true;
let verified = true;
const preparation: McpPreparationData = {
  workspaceId: SIGNED, workspaceName: "Signed team", destinationAccount: "Ada (@ada) · social-account", expiresAt: "2026-11-01T10:00:00.000Z",
  intent: {
    workspaceId: SIGNED, clientIdempotencyKey: "00000000-0000-4000-8000-000000000004", deliveryMode: "direct", projectId: "project", clipId: "clip", clipExportId: "export", clipExportVariantId: "variant", expectedEditorRevision: 7,
    accountId: "social-account", platform: "tiktok", aspectRatio: "9:16", resolution: "1080p", scheduledFor: "2026-11-01T09:00:00.000Z", caption: "Frozen caption", providerSettings: {},
  },
};
const router = { push: (href: string) => navigated.push(href), replace: (href: string) => navigated.push(href) };
mock.module("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => search }));
mock.module("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, userId: USER, getToken: async () => "session-token" }) }));

const json = (value: unknown, status = 200) => Response.json(value, { status });
async function fakeApi(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  requests.push({ url, headers: new Headers(init.headers), init });
  if (url.pathname === "/api/session/workspace-selection") {
    if (!selectedAllowed) return json({ error: "workspace_access_denied", message: "Denied", requestId: "switch-denied" }, 403);
    return json({ workspace: { id: JSON.parse(String(init.body)).workspaceId } });
  }
  if (refusal) return json(refusal, refusal.error === "integration_access_unavailable" ? 402 : 403);
  if (url.pathname === "/api/integrations/mcp/status") return json({ mcpUrl: "https://api.test/mcp", configuration: { verified, label: "Connector temporarily unavailable", description: "OAuth discovery is unavailable." }, workspace: { workspaceId: SELECTED, workspaceName: "Personal", role: "owner", status: "active", pricingTier: "pro" } });
  if (url.pathname === "/api/integrations/mcp/preparations") return json(preparation);
  if (url.pathname === "/api/mcp/confirmations") {
    if (lostResponse) { lostResponse = false; throw new TypeError("Controlled lost response"); }
    const { decision } = JSON.parse(String(init.body));
    return json({ destination: decision === "confirm" ? "/projects/project?publicationId=publication" : "/integrations/mcp/confirm?declined=1" });
  }
  if (url.pathname === "/api/integrations/mcp/upload-handoff") return json({ workspaceId: SIGNED, clientIdempotencyKey: "00000000-0000-4000-8000-000000000003", recipeName: null, recipeId: SIGNED, resumeOnly: true });
  if (url.pathname.startsWith(`/mcp/integrations/${SIGNED}/upload-sessions/`)) return json({ error: "upload_session_not_found", message: "No existing upload", requestId: "resume-missing" }, 404);
  throw new Error(`Unexpected fixture request to ${url.pathname}`);
}

beforeAll(() => {
  Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
    Element: browser.Element, Node: browser.Node, Event: browser.Event, MouseEvent: browser.MouseEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => browser.setTimeout(() => callback(browser.performance.now()), 0), cancelAnimationFrame: (handle: ReturnType<typeof browser.setTimeout>) => browser.clearTimeout(handle),
    getComputedStyle: browser.getComputedStyle.bind(browser), CSS: browser.CSS, fetch: fakeApi, IS_REACT_ACT_ENVIRONMENT: true,
  });
  process.env.NEXT_PUBLIC_API_URL = "https://api.test";
});
beforeEach(() => {
  search = new URLSearchParams({ token: TOKEN });
  requests = []; navigated = []; refusal = null; lostResponse = false; selectedAllowed = true; verified = true; runtime = null;
  browser.localStorage.clear();
  browser.localStorage.setItem(`narriflow:workspace:${USER}`, SELECTED);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  runtime?.queryClient.clear();
  root = null;
  browser.document.body.replaceChildren();
});
afterAll(() => browser.close());

async function modules() {
  const [provider, { ChakraProvider }, { system }, confirm, upload, setup, billing] = await Promise.all([
    import("@/app/_components/api-provider"), import("@chakra-ui/react"), import("@narriflow/ui/theme"), import("./confirm/confirmation-screen"), import("./upload/upload-screen"), import("./page"), import("./workspace-billing-link"),
  ]);
  return { ...provider, ChakraProvider, system, ...confirm, ...upload, McpSetup: setup.default, ...billing };
}
async function mount(view: (m: Awaited<ReturnType<typeof modules>>) => ReactNode) {
  const m = await modules();
  function Probe() { runtime = m.useApiRuntime(); return <>{view(m)}</>; }
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => root?.render(<m.ChakraProvider value={m.system}><m.ApiProvider><Probe /></m.ApiProvider></m.ChakraProvider>));
  return container;
}
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function click(container: Awaited<ReturnType<typeof mount>>, label: string) {
  const element = Array.from(container.querySelectorAll("button, a")).find((element) => element.textContent === label);
  if (!element) throw new Error(`Missing control ${label}`);
  await act(async () => {
    (element as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
function assertIdentityRequests() {
  for (const { init, headers, url } of requests) {
    expect(url.origin).toBe("https://api.test");
    expect(headers.get("Authorization")).toBe("Bearer session-token");
    expect(headers.get("X-Workspace-Id")).toBeNull();
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
}

test("setup uses the API resource and preserves degraded configuration copy", async () => {
  verified = false;
  const container = await mount((m) => <m.McpSetup />);
  await until(() => container.textContent?.includes("OAuth discovery is unavailable.") === true, "setup");
  expect(container.textContent).toContain("https://api.test/mcp");
  expect(container.textContent).toContain("Connector temporarily unavailable");
  expect(requests[0]?.headers.get("X-Workspace-Id")).toBe(SELECTED);
  expect(container.querySelector('a[href="/integrations"]')).not.toBeNull();
});

test("confirmation displays frozen facts, invalidates the signed Workspace and navigates", async () => {
  const container = await mount((m) => <m.McpConfirmationScreen />);
  await until(() => container.textContent?.includes("Frozen caption") === true, "preparation");
  expect(container.textContent).toContain("Signed team");
  expect(container.textContent).toContain("Ada (@ada)");
  const signedKey = ["nf", USER, SIGNED, "publishing", "posts"];
  const selectedKey = ["nf", USER, SELECTED, "publishing", "posts"];
  await act(async () => {
    runtime!.queryClient.setQueryData(signedKey, []);
    runtime!.queryClient.setQueryData(selectedKey, []);
  });
  await click(container, "Confirm and schedule");
  await until(() => navigated.length === 1, "confirmation navigation");
  expect(navigated).toEqual(["/projects/project?publicationId=publication"]);
  expect(runtime!.queryClient.getQueryState(signedKey)?.isInvalidated).toBe(true);
  expect(runtime!.queryClient.getQueryState(selectedKey)?.isInvalidated).toBe(false);
  expect(runtime!.scope.snapshot().workspaceId).toBe(SELECTED);
  expect(JSON.stringify(runtime!.queryClient.getQueryCache().getAll().map((q) => q.queryKey))).not.toContain(TOKEN);
  expect(JSON.stringify(runtime!.queryClient.getMutationCache().getAll().map((m) => m.state.variables))).not.toContain(TOKEN);
  expect(JSON.parse(String(requests.at(-1)?.init.body))).toEqual({ token: TOKEN, decision: "confirm" });
  assertIdentityRequests();
});

test("decline follows the returned web destination without invalidating publishing", async () => {
  const container = await mount((m) => <m.McpConfirmationScreen />);
  await until(() => container.textContent?.includes("Frozen caption") === true, "preparation");
  const key = ["nf", USER, SIGNED, "publishing", "posts"];
  await act(async () => { runtime!.queryClient.setQueryData(key, []); });
  await click(container, "Decline");
  await until(() => navigated.length === 1, "decline");
  expect(navigated).toEqual(["/integrations/mcp/confirm?declined=1"]);
  expect(runtime!.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
  assertIdentityRequests();
});

test("uncertain confirmation can retry with exactly the same signed acceptance", async () => {
  lostResponse = true;
  const container = await mount((m) => <m.McpConfirmationScreen />);
  await until(() => container.textContent?.includes("Frozen caption") === true, "preparation");
  await click(container, "Confirm and schedule");
  await until(() => container.querySelector('[role="alert"]') !== null, "retry notice");
  expect(navigated).toEqual([]);
  await click(container, "Confirm and schedule");
  await until(() => navigated.length === 1, "retry navigation");
  const posts = requests.filter((r) => r.url.pathname === "/api/mcp/confirmations");
  expect(posts).toHaveLength(2);
  expect(posts[0]?.init.body).toBe(posts[1]?.init.body);
});

for (const code of ["mcp_preparation_expired", "mcp_continuation_revoked"]) test(`${code} shows confirmation unavailable`, async () => {
  refusal = { error: code, message: "Unavailable", requestId: "refused" };
  const container = await mount((m) => <m.McpConfirmationScreen />);
  await until(() => container.textContent?.includes("Confirmation unavailable") === true, "unavailable state");
  expect(container.textContent).not.toContain("Confirm and schedule");
  expect(container.textContent).not.toContain(TOKEN);
  expect(requests).toHaveLength(1);
});

test("current plan refusal names the signed Workspace and offers its billing recovery", async () => {
  refusal = { error: "integration_access_unavailable", message: "Unavailable", requestId: "plan", details: { workspace: { workspaceId: SIGNED, workspaceName: "Signed team", role: "owner", status: "active", pricingTier: "creator" } } };
  const container = await mount((m) => <m.McpConfirmationScreen />);
  await until(() => container.textContent?.includes("Assistant connector unavailable") === true, "connector recovery");
  expect(container.textContent).toContain("Signed team is on the Creator plan");
  expect(container.querySelector('a[href="/settings/billing?plan=pro#plans"]')).not.toBeNull();
  assertIdentityRequests();
});

test("billing navigates only after the signed Workspace selection is validated", async () => {
  const container = await mount((m) => <m.WorkspaceBillingLink workspaceId={SIGNED} href="/settings/billing">Open billing</m.WorkspaceBillingLink>);
  await until(() => container.textContent?.includes("Open billing") === true, "billing control");
  await click(container, "Open billing");
  await until(() => navigated.length === 1, "billing selection");
  expect(runtime!.scope.snapshot().workspaceId).toBe(SIGNED);
  expect(navigated).toEqual(["/settings/billing"]);
  expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ workspaceId: SIGNED });
});

test("refused billing selection stays on the continuation", async () => {
  selectedAllowed = false;
  const container = await mount((m) => <m.WorkspaceBillingLink workspaceId={SIGNED} href="/settings/billing">Open billing</m.WorkspaceBillingLink>);
  await until(() => container.textContent?.includes("Open billing") === true, "billing control");
  await click(container, "Open billing");
  await until(() => container.querySelector('[role="alert"]') !== null, "switch refusal");
  expect(navigated).toEqual([]);
  expect(runtime!.scope.snapshot().workspaceId).toBe(SELECTED);
});

test("expired upload preview loads with identity scope and keeps the existing picker", async () => {
  search = new URLSearchParams({ intent: TOKEN });
  const container = await mount((m) => <m.McpUploadScreen />);
  await until(() => container.querySelector('input[type="file"]') !== null, "upload handoff");
  expect(container.textContent).toContain("Choose a video for your assistant");
  expect(container.textContent).toContain("Choose the same file to resume an interrupted upload.");
  assertIdentityRequests();
  expect(requests[0]?.url.searchParams.get("intent")).toBe(TOKEN);
});

test("expired picker uses signed MCP status controls and displays a typed refusal", async () => {
  search = new URLSearchParams({ intent: TOKEN });
  const container = await mount((m) => <m.McpUploadScreen />);
  await until(() => container.querySelector('input[type="file"]') !== null, "upload handoff");
  const input = container.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [new File(["video"], "talk.mp4", { type: "video/mp4", lastModified: 1 })], configurable: true });
  await act(async () => input.dispatchEvent(new browser.Event("change", { bubbles: true })));
  await click(container, "Upload and generate clips");
  await until(() => requests.some((r) => r.url.pathname.endsWith("/upload-sessions/status")), "MCP resume command");
  const request = requests.find((r) => r.url.pathname.endsWith("/upload-sessions/status"))!;
  expect(request.url.pathname).toBe(`/mcp/integrations/${SIGNED}/upload-sessions/status`);
  expect(request.headers.get("X-Narriflow-Upload-Intent")).toBe(TOKEN);
  expect(requests.some((r) => r.url.pathname.endsWith("/upload-sessions/open"))).toBe(false);
  expect(JSON.parse(String(request.init.body))).toMatchObject({ sessionId: null, clientIdempotencyKey: "00000000-0000-4000-8000-000000000003" });
  await until(() => container.textContent?.includes("Narriflow could not find this saved Upload Session.") === true, "typed upload refusal");
  assertIdentityRequests();
  expect(navigated).toEqual([]);
});

test("declined links preserve their empty state without a read", async () => {
  search = new URLSearchParams({ declined: "1" });
  const container = await mount((m) => <m.McpConfirmationScreen />);
  await until(() => container.textContent?.includes("Publication declined") === true, "declined state");
  expect(container.textContent).toContain("No post was scheduled.");
  expect(requests).toEqual([]);
});
