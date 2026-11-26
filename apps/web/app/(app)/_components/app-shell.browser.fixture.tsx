import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { type SessionBootstrap, type WorkspaceSummary, workspaceCapabilities } from "@narriflow/validators/api/session";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import { Window } from "happy-dom";
import { act, type ReactNode, useState, useSyncExternalStore } from "react";
import type { Root } from "react-dom/client";

// Runs in its own process (see app-shell.test.ts): it installs DOM globals.
// The real layout, ApiProvider, gate and chrome run against a fake API whose billing read never answers.

const browser = new Window({ url: "http://localhost:3000/home" });
const USER = "user_shell";
const PERSONAL = "00000000-0000-4000-8000-000000000001";
const TEAM = "00000000-0000-4000-8000-000000000002";
const HINT_KEY = `narriflow:workspace:${USER}`;
const workspaces: Record<string, WorkspaceSummary> = {
  [PERSONAL]: { id: PERSONAL, name: "Personal", role: "owner", status: "active", isPersonal: true, pricingTier: "free", avatarUrl: null },
  [TEAM]: { id: TEAM, name: "Team", role: "owner", status: "active", isPersonal: false, pricingTier: "business", avatarUrl: null },
};
let paths: string[] = [];
let failSession = false;
/** While set, the identity bootstrap waits for it; `/api/workspace/bootstrap` likewise for `holdWorkspace`. */
let holdSession: Promise<void> | null = null;
let holdWorkspace: Promise<void> | null = null;

// Next's navigation hooks. `prerendering` makes `useSearchParams` suspend the way a
// static prerender bails out, so a read outside a Suspense boundary fails the render.
let pathname = "/home";
let prerendering = false;
const never = new Promise<never>(() => undefined);
const router = { replace: () => undefined, push: () => undefined, prefetch: () => undefined };
mock.module("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => pathname,
  useParams: () => ({}),
  useSearchParams: () => {
    if (prerendering) throw never;
    return new URLSearchParams();
  },
  useServerInsertedHTML: () => undefined,
  notFound: () => {
    throw new Error("notFound");
  },
}));

let auth: { isLoaded: boolean; userId: string | null } = { isLoaded: true, userId: USER };
const authListeners = new Set<() => void>();
function setAuth(next: Partial<typeof auth>) {
  auth = { ...auth, ...next };
  for (const listener of [...authListeners]) listener();
}
const subscribeAuth = (listener: () => void) => {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
};
mock.module("@clerk/nextjs", () => ({
  useAuth: () => {
    const current = useSyncExternalStore(subscribeAuth, () => auth, () => auth);
    return { ...current, getToken: async () => (current.userId ? "session-token" : null) };
  },
  useUser: () => ({ isLoaded: true, user: null }),
  useClerk: () => ({ signOut: async () => undefined }),
}));

const json = (body: unknown, workspaceId: string | null, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}) },
  });

async function fakeApi(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  paths.push(url.pathname);
  const headers = new Headers(init?.headers);
  const user = { id: "u1", email: "a@example.test", firstName: "Ada", lastName: null, imageUrl: null };
  const memberships = Object.values(workspaces);
  if (url.pathname === "/api/session/bootstrap") {
    if (holdSession) await holdSession;
    if (failSession) return json({ error: "bad_request", message: "The session could not be read.", requestId: "r-fail" }, null, 400);
    const selected = workspaces[url.searchParams.get("workspaceId") ?? ""] ?? workspaces[PERSONAL];
    const body: SessionBootstrap = {
      user,
      memberships,
      selection: { workspaceId: selected.id, workspaceSelectionChanged: false },
      capabilities: workspaceCapabilities(selected),
      authContinuation: { issuerUrl: null, consentOrigin: null },
    };
    return json(body, null);
  }
  if (url.pathname === "/api/session/workspace-selection") {
    const chosen = workspaces[JSON.parse(String(init?.body)).workspaceId];
    return json({ workspace: chosen, capabilities: workspaceCapabilities(chosen) }, null);
  }
  const selected = workspaces[headers.get("x-workspace-id") ?? ""];
  if (!selected) return json({ error: "workspace_selection_changed", message: "Changed", requestId: "r-409" }, null, 409);
  if (url.pathname === "/api/workspace/bootstrap") {
    if (holdWorkspace) await holdWorkspace;
    const body: WorkspaceBootstrap = {
      user,
      workspace: selected,
      memberships,
      capabilities: workspaceCapabilities(selected),
      usage: {
        tier: selected.pricingTier,
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
    return json(body, selected.id);
  }
  if (url.pathname === "/api/home") {
    return json(
      {
        items: [],
        canCreate: true,
        readOnlyReason: null,
        canManageBilling: true,
        autopilot: { lockedTier: null, rules: 0, activeRules: 0 },
        showRetentionBanner: false,
      },
      selected.id,
    );
  }
  // Billing state never answers; the page must not wait for it.
  if (url.pathname === "/api/billing/state") return new Promise<Response>(() => undefined);
  return json({ ok: true }, selected.id);
}

type Modules = Awaited<ReturnType<typeof load>>;
async function load() {
  const [layout, { Provider }, provider, gate, { default: Loading }, { ProjectSkeleton }, home, projects, client, server] = await Promise.all([
    import("../layout"),
    import("@narriflow/ui/provider"),
    import("../../_components/api-provider"),
    import("../../_components/workspace-query-gate"),
    import("../loading"),
    import("../projects/[projectId]/project-skeleton"),
    import("../home/page"),
    import("../projects/page"),
    import("react-dom/client"),
    import("react-dom/server"),
  ]);
  return {
    AppLayout: layout.default,
    Provider,
    ...provider,
    ...gate,
    Loading,
    ProjectSkeleton,
    HomePage: home.default,
    ProjectsPage: projects.default,
    ...client,
    ...server,
  };
}

let switchTo: ((workspaceId: string) => Promise<boolean>) | null = null;
let mounts = 0;

/** A screen as every app screen is written: its skeleton until the Workspace is admitted. */
function Screen({ m }: { m: Modules }) {
  const scope = m.useWorkspaceScope();
  const [mount] = useState(() => ++mounts);
  switchTo = m.useWorkspaceSwitch().switchTo;
  if (!scope) return <m.Loading />;
  return (
    <p data-testid="page" data-mount={mount}>
      {scope.workspaceId}
    </p>
  );
}

function app(m: Modules, page: ReactNode) {
  return (
    <m.Provider>
      <m.AppLayout>{page}</m.AppLayout>
    </m.Provider>
  );
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
    matchMedia: browser.matchMedia.bind(browser),
    CSS: browser.CSS,
    fetch: fakeApi,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  process.env.NEXT_PUBLIC_API_URL = "http://api.test";
});

beforeEach(() => {
  paths = [];
  failSession = false;
  holdSession = null;
  holdWorkspace = null;
  pathname = "/home";
  browser.happyDOM.setURL("http://localhost:3000/home");
  prerendering = false;
  auth = { isLoaded: true, userId: USER };
  mounts = 0;
  switchTo = null;
  browser.localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
});

afterAll(async () => {
  await browser.happyDOM.close();
});

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function mountClient(m: Modules, page: ReactNode) {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = m.createRoot(container as unknown as HTMLDivElement);
  await act(async () => root?.render(app(m, page)));
  return container;
}

const page = (container: Element) => container.querySelector("[data-testid=page]");

test("the page renders as soon as the Workspace bootstrap answers, while billing is still pending", async () => {
  const m = await load();
  const container = await mountClient(m, <Screen m={m} />);
  await until(() => page(container) !== null, "the page");
  expect(paths).toContain("/api/billing/state");
  expect(page(container)?.textContent).toBe(PERSONAL);
});

describe("server render with Clerk not loaded", () => {
  // `urlBoundaries`: Suspense boundaries that read the URL's query and so fall back on
  // the server and render on the client, which React reports as a recoverable error.
  // /home and /projects render their real pages; Home's request notice reads the URL inside the page's boundary.
  const variants = [
    { path: "/home", marker: 'aria-label="Collapse sidebar"', urlBoundaries: 1 },
    { path: "/projects", marker: 'aria-label="Collapse sidebar"', urlBoundaries: 0 },
    { path: "/settings/billing", marker: 'aria-label="Settings sections"', urlBoundaries: 0 },
    { path: "/upload", marker: 'aria-label="Narriflow home"', urlBoundaries: 0 },
    { path: "/projects/project-1", marker: 'href="/projects"', urlBoundaries: 1 },
  ];
  for (const { path, marker, urlBoundaries } of variants) {
    test(`${path} prerenders its chrome and the route skeleton, and hydrates without a mismatch`, async () => {
      const m = await load();
      pathname = path;
      auth = { isLoaded: false, userId: null };
      const skeleton =
        path === "/home" ? <m.HomePage /> : path === "/projects" ? <m.ProjectsPage /> : path.startsWith("/projects/") ? <m.ProjectSkeleton /> : <Screen m={m} />;

      // A static prerender: no Clerk, and the URL's query is unknown (it suspends).
      prerendering = true;
      const html = m.renderToString(app(m, skeleton));
      prerendering = false;
      expect(html).toContain(marker);
      expect(html).toContain('aria-busy="true"');
      // Only the route skeleton is busy; the chrome's bones are decorative.
      expect(html.match(/aria-busy="true"/g)).toHaveLength(1);
      expect(paths).toEqual([]);

      const container = browser.document.createElement("div");
      browser.document.body.append(container);
      container.innerHTML = html;
      const problems: unknown[] = [];
      let clientRendered = 0;
      const consoleError = console.error;
      console.error = (...args: unknown[]) => problems.push(args);
      try {
        await act(async () => {
          root = m.hydrateRoot(container as unknown as HTMLDivElement, app(m, skeleton), {
            onRecoverableError: (error) => {
              if (String(error).includes("Switched to client rendering because the server rendering aborted")) clientRendered++;
              else problems.push(error);
            },
          });
        });
      } finally {
        console.error = consoleError;
      }
      expect(problems).toEqual([]);
      expect(clientRendered).toBe(urlBoundaries);
      expect(paths).toEqual([]);
    });
  }
});

test("the pending chrome takes the remembered slot sizes before the first paint, and today's without them", async () => {
  const m = await load();
  const { CHROME_LAYOUT_KEY, CHROME_LAYOUT_SCRIPT } = await import("@/lib/chrome-layout-hint");
  auth = { isLoaded: false, userId: null };
  const container = await mountClient(m, <Screen m={m} />);
  const html = browser.document.documentElement;
  const style = (element: Element | null | undefined) => {
    if (!element) throw new Error("placeholder missing");
    return browser.getComputedStyle(element as unknown as Parameters<typeof browser.getComputedStyle>[0]);
  };
  // The desktop top bar's actions: search, Invite, the credits pill, theme, account.
  const placeholders = () => {
    const actions = container.querySelector("header")?.lastElementChild;
    const [, invite, pill] = [...(actions?.children ?? [])];
    return {
      newProject: container.querySelector("nav > .chakra-skeleton"),
      invite,
      balance: pill?.querySelector('[class*="skeleton"] span span'),
      upgrade: pill?.lastElementChild,
    };
  };
  const before = placeholders();
  expect(style(before.newProject).display).toBe("block");
  expect(style(before.invite).display).toBe("block");
  expect(style(before.invite).width).toBe("auto");
  expect(style(before.balance).minWidth).toBe("0px");
  expect(style(before.upgrade).width).toBe("0px");

  browser.localStorage.setItem(CHROME_LAYOUT_KEY, JSON.stringify({ balance: 41, upgrade: 99, invite: 0, newProject: false }));
  // The root layout's before-paint script, against this document and storage.
  new Function("localStorage", "document", CHROME_LAYOUT_SCRIPT)(browser.localStorage, browser.document);
  try {
    const after = placeholders();
    expect(style(after.newProject).display).toBe("none");
    expect(style(after.invite).display).toBe("none");
    expect(style(after.balance).minWidth).toBe("41px");
    expect(style(after.upgrade).width).toBe("99px");
  } finally {
    html.removeAttribute("style");
  }
});

test("while pending, nav links are real and no placeholder can take focus", async () => {
  const m = await load();
  auth = { isLoaded: false, userId: null };
  const container = await mountClient(m, <Screen m={m} />);
  expect(container.querySelector('nav a[href="/projects"]')).not.toBeNull();
  expect(container.querySelector('a[href="/upload"]')).toBeNull();
  const hidden = container.querySelectorAll('[aria-hidden="true"]');
  expect(hidden.length).toBeGreaterThan(0);
  for (const element of hidden) {
    expect(element.querySelector("a, button, input, [tabindex]")).toBeNull();
  }
  expect(container.querySelector('[aria-label="Switch workspace"]')).toBeNull();
  expect(container.querySelector('[aria-label="Account menu"]')).toBeNull();

  await act(async () => setAuth({ isLoaded: true, userId: USER }));
  await until(() => page(container) !== null, "the page");
  expect(container.querySelector('[aria-label="Switch workspace"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Account menu"]')).not.toBeNull();
  expect(container.querySelector('a[href="/upload"]')).not.toBeNull();
});

test("the page mounts once across the first adoption and remounts on a Workspace switch", async () => {
  const m = await load();
  auth = { isLoaded: false, userId: null };
  browser.localStorage.setItem(HINT_KEY, PERSONAL);
  const container = await mountClient(m, <Screen m={m} />);
  expect(mounts).toBe(1);

  await act(async () => setAuth({ isLoaded: true, userId: USER }));
  await until(() => page(container)?.textContent === PERSONAL, "the personal Workspace");
  expect(page(container)?.getAttribute("data-mount")).toBe("1");
  expect(mounts).toBe(1);
  const sidebar = container.querySelector("aside");
  const pageNode = page(container);
  expect(sidebar).not.toBeNull();

  await act(async () => {
    await switchTo?.(TEAM);
  });
  await until(() => page(container)?.textContent === TEAM, "the team Workspace");
  // A new page instance: nothing captured in Personal survives into Team.
  expect(Number(page(container)?.getAttribute("data-mount"))).toBeGreaterThan(1);
  expect(page(container)).not.toBe(pageNode);
  // The chrome stayed: the sidebar is the same element, not a new one.
  expect(container.querySelector("aside")).toBe(sidebar);
  expect(sidebar?.isConnected).toBe(true);
});

test("a session that cannot be read fails inside the panel and keeps the chrome", async () => {
  const m = await load();
  failSession = true;
  const container = await mountClient(m, <Screen m={m} />);
  await until(() => container.textContent?.includes("Try again") === true, "the failure");
  expect(container.querySelector("main [role=alert]")).not.toBeNull();
  expect(container.querySelector('[aria-label="Collapse sidebar"]')).not.toBeNull();
  expect(page(container)).toBeNull();

  failSession = false;
  const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Try again");
  await act(async () => (retry as unknown as HTMLButtonElement).click());
  await until(() => page(container) !== null, "the page after retry");
});

const backLinks = (container: Element) =>
  Array.from(container.querySelectorAll("a")).filter((link) => link.textContent === "Back").map((link) => link.getAttribute("href"));

test("settings Back takes a page left while the Workspace opened, and never another Workspace's", async () => {
  const m = await load();
  auth = { isLoaded: false, userId: null };
  browser.localStorage.setItem(HINT_KEY, PERSONAL);
  pathname = "/projects";
  browser.happyDOM.setURL("http://localhost:3000/projects?folder=f1");
  const container = await mountClient(m, <Screen m={m} />);

  // Still pending: the person opens Billing.
  pathname = "/settings/billing";
  browser.happyDOM.setURL("http://localhost:3000/settings/billing");
  await act(async () => root?.render(app(m, <Screen m={m} />)));
  expect(backLinks(container).every((href) => href === "/home")).toBe(true);

  await act(async () => setAuth({ isLoaded: true, userId: USER }));
  await until(() => page(container)?.textContent === PERSONAL, "the personal Workspace");
  expect(backLinks(container)).toEqual(["/projects?folder=f1", "/projects?folder=f1"]);

  // Switching: while Team opens, and once it is open, Back does not lead into Personal's page.
  let release: () => void = () => {};
  holdWorkspace = new Promise<void>((resolve) => {
    release = resolve;
  });
  await act(async () => {
    await switchTo?.(TEAM);
  });
  expect(page(container)).toBeNull();
  expect(backLinks(container).every((href) => href === "/home")).toBe(true);
  holdWorkspace = null;
  await act(async () => release());
  await until(() => page(container)?.textContent === TEAM, "the team Workspace");
  expect(backLinks(container).every((href) => href === "/home")).toBe(true);
});

test("a hard load of /home with a saved Workspace reads the dashboard beside the session bootstrap, once", async () => {
  const m = await load();
  browser.localStorage.setItem(HINT_KEY, PERSONAL);
  let release: () => void = () => {};
  holdSession = new Promise<void>((resolve) => {
    release = resolve;
  });
  const container = await mountClient(m, <m.HomePage />);
  await until(() => paths.includes("/api/home"), "the dashboard read");
  // The session bootstrap has not answered: the screen is still its skeleton.
  expect(container.querySelector('main [aria-busy="true"]')).not.toBeNull();

  holdSession = null;
  await act(async () => release());
  await until(() => container.querySelector('main [aria-busy="true"]') === null, "the dashboard");
  expect(paths.filter((path) => path === "/api/home")).toHaveLength(1);
});
