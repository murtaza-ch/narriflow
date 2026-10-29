import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { type SessionBootstrap, type WorkspaceSummary, workspaceCapabilities } from "@narriflow/validators/api/session";
import type { McpPreparationData } from "@narriflow/validators/api/integrations";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Isolated process (see continuation-shell.test.ts): real provider, runtime, gates
// and screens against a fake API whose selected Workspace is restricted for this member.

const browser = new Window({ url: "http://localhost:3000/integrations/mcp/confirm?token=signed" });
const USER = "user_continuation";
const PERSONAL = "00000000-0000-4000-8000-000000000001";
const RESTRICTED = "00000000-0000-4000-8000-000000000002";
const SIGNED = "00000000-0000-4000-8000-000000000003";

type Member = Pick<WorkspaceSummary, "id" | "name" | "role" | "status" | "isPersonal" | "pricingTier">;
const personal: Member = { id: PERSONAL, name: "Personal", role: "owner", status: "active", isPersonal: true, pricingTier: "free" };
const restricted: Member = { id: RESTRICTED, name: "Paused team", role: "editor", status: "restricted", isPersonal: false, pricingTier: "business" };
const summary = (member: Member): WorkspaceSummary => ({ ...member, avatarUrl: null });

const preparation: McpPreparationData = {
  workspaceId: SIGNED, workspaceName: "Signed team", destinationAccount: "Ada (@ada) · social-account", expiresAt: "2026-11-01T10:00:00.000Z",
  intent: {
    workspaceId: SIGNED, clientIdempotencyKey: "00000000-0000-4000-8000-000000000004", deliveryMode: "direct", projectId: "project", clipId: "clip", clipExportId: "export", clipExportVariantId: "variant", expectedEditorRevision: 7,
    accountId: "social-account", platform: "tiktok", aspectRatio: "9:16", resolution: "1080p", scheduledFor: "2026-11-01T09:00:00.000Z", caption: "Frozen caption", providerSettings: {},
  },
};

let paths: string[] = [];
const replaced: string[] = [];
let signedIn = true;
const router = { replace: (href: string) => replaced.push(href), push: (href: string) => replaced.push(href) };
mock.module("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/integrations/mcp/confirm",
  useSearchParams: () => new URLSearchParams({ token: "signed" }),
}));
mock.module("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, userId: signedIn ? USER : null, getToken: async () => "session-token" }),
  useClerk: () => ({ signOut: async () => undefined }),
}));

const json = (body: unknown, status = 200) => Response.json(body, { status });
async function fakeApi(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  paths.push(url.pathname);
  const user = { id: "u1", email: "a@example.test", firstName: "Ada", lastName: null, imageUrl: null };
  if (url.pathname === "/api/session/bootstrap") {
    const body: SessionBootstrap = {
      user,
      memberships: [personal, restricted].map(summary),
      selection: { workspaceId: RESTRICTED, workspaceSelectionChanged: false },
      capabilities: workspaceCapabilities(restricted),
      authContinuation: { issuerUrl: null, consentOrigin: null },
    };
    return json(body);
  }
  if (url.pathname === "/api/integrations/mcp/preparations") return json(preparation);
  throw new Error(`Unexpected fixture request to ${url.pathname}`);
}

let root: Root | null = null;
async function mount(view: (m: Awaited<ReturnType<typeof modules>>) => ReactNode) {
  const m = await modules();
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () =>
    root?.render(
      <m.ChakraProvider value={m.system}>
        <m.ColorModeProvider>
          <m.SessionApiProvider>{view(m)}</m.SessionApiProvider>
        </m.ColorModeProvider>
      </m.ChakraProvider>,
    ),
  );
  return container;
}
async function modules() {
  const [{ ChakraProvider }, { system }, { ColorModeProvider }, gate, shell, chrome, confirm] = await Promise.all([
    import("@chakra-ui/react"),
    import("@narriflow/ui/theme"),
    import("@narriflow/ui/components/color-mode"),
    import("@/app/_components/workspace-query-gate"),
    import("./continuation-shell"),
    import("@/app/(app)/_components/app-chrome"),
    import("./integrations/mcp/confirm/confirmation-screen"),
  ]);
  return { ChakraProvider, system, ColorModeProvider, ...gate, ...shell, ...chrome, ...confirm };
}
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  throw new Error(`Timed out waiting for ${label}`);
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
  paths = [];
  replaced.length = 0;
  signedIn = true;
  browser.localStorage.clear();
  browser.localStorage.setItem(`narriflow:workspace:${USER}`, RESTRICTED);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
});
afterAll(() => browser.close());

test("the confirmation renders for a member whose selected Workspace is restricted", async () => {
  const container = await mount((m) => (
    <m.ContinuationShell>
      <m.McpConfirmationScreen />
    </m.ContinuationShell>
  ));
  await until(() => container.textContent?.includes("Frozen caption") === true, "the confirmation facts");
  expect(container.textContent).toContain("Signed team");
  expect(paths).toContain("/api/session/bootstrap");
  expect(paths).not.toContain("/api/workspace/bootstrap");
  expect(paths).not.toContain("/api/billing/state");
  expect(replaced).toEqual([]);
});

test("a signed-out visitor is sent to sign in and back to the same link", async () => {
  signedIn = false;
  const container = await mount((m) => (
    <m.ContinuationShell>
      <p>screen</p>
    </m.ContinuationShell>
  ));
  await until(() => replaced.length > 0, "the sign-in redirect");
  expect(replaced[0]).toContain("sign-in");
  expect(decodeURIComponent(replaced[0] ?? "")).toContain("/integrations/mcp/confirm?token=signed");
  expect(container.textContent).not.toContain("screen");
  expect(paths).toEqual([]);
});

test("other app routes still go through the selected-Workspace gate", async () => {
  const container = await mount((m) => (
    <m.AppShell>
      <p>app page</p>
    </m.AppShell>
  ));
  await until(() => replaced.length > 0, "the workspace-unavailable redirect");
  expect(replaced).toEqual(["/workspace-unavailable"]);
  expect(container.textContent).not.toContain("app page");
  expect(paths).not.toContain("/api/integrations/mcp/preparations");
});
