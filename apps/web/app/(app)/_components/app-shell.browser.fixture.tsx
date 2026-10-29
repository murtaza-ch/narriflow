import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { type SessionBootstrap, type WorkspaceSummary, workspaceCapabilities } from "@narriflow/validators/api/session";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Runs in its own process (see app-shell.test.ts): it installs DOM globals.
// The real ApiProvider, gates and shell run against a fake API whose billing read never answers.

const browser = new Window({ url: "http://localhost:3000/home" });
const USER = "user_shell";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const workspace: WorkspaceSummary = {
  id: WORKSPACE,
  name: "Personal",
  role: "owner",
  status: "active",
  isPersonal: true,
  pricingTier: "free",
  avatarUrl: null,
};
const paths: string[] = [];

const router = { replace: () => undefined, push: () => undefined, prefetch: () => undefined };
mock.module("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/home",
  useSearchParams: () => new URLSearchParams(),
}));
mock.module("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, userId: USER, getToken: async () => "session-token" }),
  useUser: () => ({ isLoaded: true, user: null }),
  useClerk: () => ({ signOut: async () => undefined }),
}));

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Workspace-Id": WORKSPACE },
  });

async function fakeApi(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  paths.push(url.pathname);
  const user = { id: "u1", email: "a@example.test", firstName: "Ada", lastName: null, imageUrl: null };
  if (url.pathname === "/api/session/bootstrap") {
    const body: SessionBootstrap = {
      user,
      memberships: [workspace],
      selection: { workspaceId: WORKSPACE, workspaceSelectionChanged: false },
      capabilities: workspaceCapabilities(workspace),
      authContinuation: { issuerUrl: null, consentOrigin: null },
    };
    return json(body);
  }
  if (url.pathname === "/api/workspace/bootstrap") {
    const body: WorkspaceBootstrap = {
      user,
      workspace,
      memberships: [workspace],
      capabilities: workspaceCapabilities(workspace),
      usage: {
        tier: "free",
        usedCredits: 1,
        reservedCredits: 0,
        limitCredits: 10,
        remainingCredits: 9,
        periodStart: "2026-10-01T00:00:00.000Z",
        renewsAt: "2026-11-01T00:00:00.000Z",
        inFlight: 0,
        inFlightLimit: 1,
        maxUploadSeconds: 600,
      },
    };
    return json(body);
  }
  // Billing state never answers; the page must not wait for it.
  if (url.pathname === "/api/billing/state") return new Promise<Response>(() => undefined);
  return json({ ok: true });
}

let root: Root | null = null;

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

test("the page renders as soon as the Workspace bootstrap answers, while billing is still pending", async () => {
  const [{ ChakraProvider }, { ColorModeProvider }, { system }, { ApiProvider }, { AppShell }] = await Promise.all([
    import("@chakra-ui/react"),
    import("@narriflow/ui/components/color-mode"),
    import("@narriflow/ui/theme"),
    import("../../_components/api-provider"),
    import("./app-chrome"),
  ]);
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root?.render(
      <ChakraProvider value={system}>
        <ColorModeProvider>
          <ApiProvider fallback={<p>pending</p>}>
            <AppShell>
              <p data-testid="page">the page</p>
            </AppShell>
          </ApiProvider>
        </ColorModeProvider>
      </ChakraProvider>,
    );
  });
  for (let attempt = 0; attempt < 100 && !container.querySelector("[data-testid=page]"); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  expect(paths).toContain("/api/billing/state");
  expect(container.querySelector("[data-testid=page]")?.textContent).toBe("the page");
});
