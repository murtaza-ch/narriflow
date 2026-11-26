import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type SessionBootstrap,
  type WorkspaceSummary,
  workspaceCapabilities,
} from "@narriflow/validators/api/session";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import { Window } from "happy-dom";
import { useQuery } from "@tanstack/react-query";
import { act, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

// Runs in its own process (see workspace-query-gate.test.ts): it installs DOM globals.
// The real ApiProvider, runtime, transport and query client run against a fake API.
// The app shell's gate never unmounts its children, so "the screen cannot read yet"
// is asserted as "the gated scope is null and the status is pending".

const browser = new Window({ url: "http://localhost:3000/home" });

const USER = "user_gate";
const OTHER_USER = "user_other";
const PERSONAL = "00000000-0000-4000-8000-000000000001";
const TEAM = "00000000-0000-4000-8000-000000000002";
const REMOVED = "00000000-0000-4000-8000-000000000003";
const PAUSED = "00000000-0000-4000-8000-000000000004";
const STUDIO = "00000000-0000-4000-8000-000000000005";
const HINT_KEY = `narriflow:workspace:${USER}`;

type Member = Pick<WorkspaceSummary, "id" | "name" | "role" | "status" | "isPersonal" | "pricingTier">;
const personal: Member = { id: PERSONAL, name: "Personal", role: "owner", status: "active", isPersonal: true, pricingTier: "free" };
const team: Member = { id: TEAM, name: "Team", role: "owner", status: "active", isPersonal: false, pricingTier: "business" };
const paused: Member = { id: PAUSED, name: "Paused", role: "editor", status: "restricted", isPersonal: false, pricingTier: "business" };
const studio: Member = { id: STUDIO, name: "Studio", role: "editor", status: "active", isPersonal: false, pricingTier: "pro" };

interface Call {
  method: string;
  path: string;
  hint: string | null;
  workspaceHeader: string | null;
  /** The Workspace a screen was admitted to when the request left (the probe's last observation). */
  admitted: string | null;
}
let calls: Call[];
let memberships: Member[];
let restrictedContent = false;
let ownerCanResolve = false;
let failBootstrap = false;
/** While set, the identity bootstrap waits for it before answering. */
let holdBootstrap: Promise<void> | null = null;
/** While set, `/api/home` waits for it (or for its request's abort) before answering. */
let holdHome: Promise<void> | null = null;
let restrictedBootstrap = false;
/** Why each held request was aborted. */
let aborts: string[] = [];
/** `seen.length` when the probe's command learned it was refused. */
let refusedAt = -1;
const replaced: string[] = [];

const router = { replace: (href: string) => replaced.push(href), push: (href: string) => replaced.push(href) };
mock.module("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/home" }));

// Clerk as an external store, so a test can load it late or switch the user.
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
}));

function summary(member: Member): WorkspaceSummary {
  return { ...member, avatarUrl: null };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

async function fakeApi(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const call: Call = {
    method: (init?.method ?? "GET").toUpperCase(),
    path: url.pathname,
    hint: url.searchParams.get("workspaceId"),
    workspaceHeader: headers.get("x-workspace-id"),
    admitted: seen.at(-1)?.scope?.workspaceId ?? null,
  };
  calls.push(call);
  const user = { id: "u1", email: "a@example.test", firstName: "Ada", lastName: null, imageUrl: null };

  if (call.path === "/api/session/bootstrap") {
    if (holdBootstrap) await holdBootstrap;
    if (failBootstrap) {
      return json({ error: "authentication_unavailable", message: "Sign-in is briefly unavailable.", requestId: "r-outage" }, 503);
    }
    const effective = memberships.find((member) => member.id === call.hint) ?? memberships.find((member) => member.isPersonal);
    if (!effective) throw new Error("fixture needs a personal Workspace");
    const body: SessionBootstrap = {
      user,
      memberships: memberships.map(summary),
      selection: { workspaceId: effective.id, workspaceSelectionChanged: effective.id !== call.hint && call.hint !== null },
      capabilities: workspaceCapabilities(effective),
      authContinuation: { issuerUrl: null, consentOrigin: null },
    };
    return json(body);
  }
  if (call.path === "/api/session/workspace-selection") {
    const chosen = memberships.find((member) => member.id === JSON.parse(String(init?.body)).workspaceId);
    if (!chosen) return json({ error: "workspace_access_denied", message: "No", requestId: "r-denied" }, 403);
    return json({ workspace: summary(chosen), capabilities: workspaceCapabilities(chosen) });
  }

  if (call.path === "/api/home" && holdHome) {
    const hold = holdHome;
    const signal = init?.signal;
    await new Promise<void>((resolve, reject) => {
      void hold.then(resolve);
      signal?.addEventListener("abort", () => {
        aborts.push(String((signal.reason as { code?: string } | undefined)?.code ?? signal.reason));
        reject(signal.reason);
      });
    });
  }

  // Every other route is Workspace-scoped: a selection that is no longer a membership is refused.
  const selected = memberships.find((member) => member.id === call.workspaceHeader);
  if (!selected) {
    return json({ error: "workspace_selection_changed", message: "Your Workspace selection changed.", requestId: "r-409" }, 409);
  }
  // A paused Workspace refuses its content to a member (the bootstrap answers, so the gate can say why).
  const pausedRead = selected.status === "restricted" && call.path !== "/api/workspace/bootstrap";
  if ((call.path === "/api/projects/explorer" && restrictedContent) || pausedRead || (call.path === "/api/workspace/bootstrap" && restrictedBootstrap)) {
    return json(
      { error: "workspace_restricted", message: "Paused", requestId: "r-paused", details: { ownerCanResolve: ownerCanResolve } },
      403,
      { "X-Workspace-Id": selected.id },
    );
  }
  if (call.path === "/api/workspace/bootstrap") {
    const body: WorkspaceBootstrap = {
      user,
      workspace: summary(selected),
      memberships: memberships.map(summary),
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
    return json(body, 200, { "X-Workspace-Id": selected.id });
  }
  return json({ ok: true }, 200, { "X-Workspace-Id": selected.id });
}

let root: Root | null = null;
type Runtime = import("@narriflow/api-client").ApiRuntime;
let runtimeRef: Runtime | null = null;
let probe: { switchTo: (id: string) => Promise<boolean> } | null = null;

/** Every render and effect of the probe: what a screen would have seen. */
interface Seen {
  phase: "render" | "effect";
  status: string;
  scope: { userId: string; workspaceId: string } | null;
  bootstrapId: string | null;
  clerkUserId: string | null;
  mount: number;
}
let seen: Seen[] = [];
let mounts = 0;

async function mount(children: (modules: Awaited<ReturnType<typeof loadAll>>) => ReactNode) {
  const modules = await loadAll();
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root?.render(
      <modules.ChakraProvider value={modules.system}>
        <modules.SessionApiProvider renderWhilePending>{children(modules)}</modules.SessionApiProvider>
      </modules.ChakraProvider>,
    );
  });
  return container;
}

async function loadAll() {
  const [{ ChakraProvider }, { system }, provider, gate] = await Promise.all([
    import("@chakra-ui/react"),
    import("@narriflow/ui/theme"),
    import("./api-provider"),
    import("./workspace-query-gate"),
  ]);
  return { ChakraProvider, system, ...provider, ...gate };
}

type Modules = Awaited<ReturnType<typeof loadAll>>;

function Probe({ modules }: { modules: Modules }) {
  const { useWorkspaceGate, useWorkspaceSwitch, useApiRuntime, useWorkspaceScope, GateFailure } = modules;
  const gate = useWorkspaceGate();
  const { switchTo } = useWorkspaceSwitch();
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  runtimeRef = runtime;
  probe = { switchTo };
  const entry = {
    status: gate.status,
    scope,
    bootstrapId: gate.status === "ready" ? gate.bootstrap.workspace.id : null,
    clerkUserId: auth.userId,
  };
  const [mountId] = useState(() => ++mounts);
  seen.push({ phase: "render", ...entry, mount: mountId });
  useEffect(() => {
    seen.push({ phase: "effect", ...entry, mount: mountId });
  });
  return (
    <div>
      <p data-testid="status">{gate.status}</p>
      {gate.status === "ready" ? (
        <>
          <p data-testid="workspace">{gate.bootstrap.workspace.id}</p>
          <p data-testid="changed">{String(gate.selectionChanged)}</p>
        </>
      ) : null}
      {gate.status === "failed" ? (
        <GateFailure variant="panel" title={gate.title} error={gate.error} fallback={gate.message} onRetry={gate.retry} />
      ) : null}
      <button
        type="button"
        data-testid="command"
        onClick={() => {
          if (!scope) return;
          void runtime.transport
            .scoped(scope)
            .json("/api/projects", { method: "POST", json: {} })
            .catch(() => {
              // The transport has told the gate by now; nothing after this may expose Team.
              refusedAt = seen.length;
            });
        }}
      >
        command
      </button>
    </div>
  );
}

/** The route read the shell prefetches under a saved hint, keyed as a screen keys it. */
function homeRead(runtime: Runtime, scope: { userId: string; workspaceId: string }) {
  return {
    queryKey: ["nf", scope.userId, scope.workspaceId, "projects", "home"] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => runtime.transport.scoped(scope).json<{ ok: boolean }>("/api/home", { signal }),
  };
}

const NO_SCOPE = { userId: "", workspaceId: "" };

/** A screen as screens are written: its read starts by itself once the gated scope is non-null. */
function ScreenProbe({ modules, path }: { modules: Modules; path: "/api/home" | "/api/screen" }) {
  const runtime = modules.useApiRuntime();
  const scope = modules.useWorkspaceScope();
  const read =
    path === "/api/home"
      ? homeRead(runtime, scope ?? NO_SCOPE)
      : {
          queryKey: ["nf", scope?.userId ?? "", scope?.workspaceId ?? "", "projects", "screen"] as const,
          queryFn: ({ signal }: { signal: AbortSignal }) =>
            runtime.transport.scoped(scope ?? NO_SCOPE).json<{ ok: boolean }>("/api/screen", { signal }),
        };
  const query = useQuery({ ...read, enabled: scope !== null });
  return query.data ? <p data-testid={path === "/api/home" ? "home" : "screen"}>{scope?.workspaceId}</p> : null;
}

/** The app shell's gate with what it prefetches under a saved hint: the current route's read. */
function Gates({ modules }: { modules: Modules }) {
  const runtime = modules.useApiRuntime();
  return (
    <modules.WorkspaceGateProvider prefetchUnderHint={(scope) => [homeRead(runtime, scope)]}>
      <Probe modules={modules} />
      <ScreenProbe modules={modules} path="/api/home" />
      <ScreenProbe modules={modules} path="/api/screen" />
    </modules.WorkspaceGateProvider>
  );
}

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

const text = (container: Element, id: string) => container.querySelector(`[data-testid=${id}]`)?.textContent ?? null;

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

beforeEach(() => {
  calls = [];
  replaced.length = 0;
  probe = null;
  runtimeRef = null;
  memberships = [personal, team];
  restrictedContent = false;
  ownerCanResolve = false;
  failBootstrap = false;
  holdBootstrap = null;
  holdHome = null;
  restrictedBootstrap = false;
  aborts = [];
  refusedAt = -1;
  auth = { isLoaded: true, userId: USER };
  seen = [];
  mounts = 0;
  browser.localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
});

afterAll(() => browser.close());

const scoped = () => calls.filter((call) => call.workspaceHeader !== null);
const requests = (path: string) => calls.filter((call) => call.path === path);
const cachedWorkspaces = () => new Set(runtimeRef?.queryClient.getQueryCache().findAll().map((query) => query.queryKey[2]));
/** Every Workspace a screen could have read under. */
const exposed = () => seen.flatMap((entry) => (entry.scope ? [entry.scope.workspaceId] : []));

/** The gate's invariants on every render and effect a screen could see. */
function expectNoUnvalidatedScope() {
  for (const entry of seen) {
    if (entry.scope === null) continue;
    // Only `ready` admits a scope, its bootstrap is that same Workspace's, and it is Clerk's user.
    expect(entry.status).toBe("ready");
    expect(entry.bootstrapId).toBe(entry.scope.workspaceId);
    expect(entry.scope.userId).toBe(entry.clerkUserId as string);
  }
  // A screen's own read starts by itself, and only under the Workspace it was admitted to.
  for (const call of requests("/api/screen")) expect(call.workspaceHeader).toBe(call.admitted as string);
}

function storageEvent(key: string, newValue: string) {
  browser.localStorage.setItem(key, newValue);
  browser.dispatchEvent(new browser.StorageEvent("storage", { key, newValue, storageArea: browser.localStorage }));
}

describe("session and Workspace gates", () => {
  test("a removed saved Workspace falls back to the personal one and no data from the hint is ever shown", async () => {
    browser.localStorage.setItem(HINT_KEY, REMOVED);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") !== null && text(container, "home") !== null, "the Workspace and its route read");

    expect(text(container, "workspace")).toBe(PERSONAL);
    expect(text(container, "changed")).toBe("true");
    expect(requests("/api/session/bootstrap")[0]?.hint).toBe(REMOVED);
    // Under the hint only the route read went out (refused); it left nothing in the cache.
    expect(scoped().filter((call) => call.workspaceHeader === REMOVED).map((call) => call.path)).toEqual(["/api/home"]);
    expect(cachedWorkspaces().has(REMOVED)).toBe(false);
    expect(text(container, "home")).toBe(PERSONAL);
    expect(browser.localStorage.getItem(HINT_KEY)).toBe(PERSONAL);
    // The saved hint was never a scope a screen could read under.
    expect(exposed()).not.toContain(REMOVED);
    expect(seen.find((entry) => entry.phase === "render")?.status).toBe("pending");
    expectNoUnvalidatedScope();
  });

  test("a valid saved Workspace is kept without announcing a change", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") !== null, "the Workspace bootstrap");
    expect(text(container, "workspace")).toBe(TEAM);
    expect(text(container, "changed")).toBe("false");
  });

  test("a member of a paused Workspace is sent to the page outside the shell and never sees its content", async () => {
    memberships = [personal, paused];
    browser.localStorage.setItem(HINT_KEY, PAUSED);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => replaced.length > 0, "the recovery redirect");
    expect(replaced).toEqual(["/workspace-unavailable"]);
    expect(text(container, "status")).toBe("pending");
    expect(exposed()).toEqual([]);
    expect(calls.some((call) => call.path === "/api/workspace/bootstrap")).toBe(false);
  });

  test("switching cancels the old Workspace, adopts the new one and reads its bootstrap", async () => {
    browser.localStorage.setItem(HINT_KEY, PERSONAL);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") === PERSONAL, "the personal Workspace");
    const before = calls.length;

    let switched = false;
    await act(async () => {
      switched = (await probe?.switchTo(TEAM)) ?? false;
    });
    expect(switched).toBe(true);
    await until(() => text(container, "workspace") === TEAM, "the team Workspace");

    const after = calls.slice(before);
    expect(after[0]?.path).toBe("/api/session/workspace-selection");
    expect(after[0]?.workspaceHeader).toBeNull();
    expect(after.some((call) => call.path === "/api/workspace/bootstrap" && call.workspaceHeader === TEAM)).toBe(true);
    expect(runtimeRef?.queryClient.getQueryData(["nf", USER, PERSONAL, "workspace", "bootstrap"])).toBeUndefined();
    expect(browser.localStorage.getItem(HINT_KEY)).toBe(TEAM);
    // Between the switch and Team's bootstrap the gate is pending, never Personal's bootstrap under Team.
    expectNoUnvalidatedScope();
  });

  test("a content read refused as paused sends the person to the recovery page without a retry loop", async () => {
    browser.localStorage.setItem(HINT_KEY, PERSONAL);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") === PERSONAL, "the personal Workspace");
    restrictedContent = true;
    const runtime = runtimeRef;
    if (!runtime) throw new Error("runtime not captured");
    const scope = { userId: USER, workspaceId: PERSONAL };
    await act(async () => {
      await runtime.queryClient
        .fetchQuery({
          queryKey: ["nf", USER, PERSONAL, "projects", "explorer", {}],
          queryFn: () => runtime.transport.scoped(scope).json("/api/projects/explorer"),
          retry: false,
        })
        .catch(() => undefined);
    });
    await until(() => replaced.length > 0, "the recovery redirect");
    expect(replaced).toEqual(["/workspace-unavailable"]);

    replaced.length = 0;
    ownerCanResolve = true;
    await act(async () => {
      await runtime.queryClient
        .fetchQuery({
          queryKey: ["nf", USER, PERSONAL, "projects", "explorer", { again: true }],
          queryFn: () => runtime.transport.scoped(scope).json("/api/projects/explorer"),
          retry: false,
        })
        .catch(() => undefined);
    });
    await until(() => replaced.length > 0, "the owner's billing redirect");
    expect(replaced).toEqual(["/settings/billing"]);
  });

  test("a selection removed mid-session is re-bootstrapped and the refused command is never replayed", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") === TEAM, "the team Workspace");

    memberships = [personal];
    const command = container.querySelector("[data-testid=command]") as unknown as HTMLButtonElement;
    await act(async () => {
      command.click();
    });
    await until(() => text(container, "workspace") === PERSONAL, "the fallback Workspace");

    const posts = calls.filter((call) => call.method === "POST" && call.path === "/api/projects");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.workspaceHeader).toBe(TEAM);
    expect(text(container, "changed")).toBe("true");
    expect(calls.filter((call) => call.path === "/api/session/bootstrap").length).toBeGreaterThanOrEqual(2);
    expectNoUnvalidatedScope();
  });

  test("a failed re-bootstrap after a refusal keeps the shell closed, shows a retry, and adopts only a fresh bootstrap", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") === TEAM, "the team Workspace");
    runtimeRef?.queryClient.setDefaultOptions({ queries: { retry: false } });

    memberships = [personal];
    failBootstrap = true;
    const command = container.querySelector("[data-testid=command]") as unknown as HTMLButtonElement;
    await act(async () => {
      command.click();
    });
    // The transport retries a 503 before giving up, so allow the failure to settle.
    for (let attempt = 0; attempt < 400 && !container.textContent?.includes("Try again"); attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(container.textContent).toContain("Try again");
    expect(text(container, "status")).toBe("failed");
    expect(text(container, "workspace")).toBeNull();
    expect(container.textContent).not.toContain(TEAM);

    failBootstrap = false;
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Try again");
    await act(async () => {
      (retry as unknown as HTMLButtonElement).click();
    });
    await until(() => text(container, "workspace") === PERSONAL, "the fallback Workspace after retry");
    expect(text(container, "changed")).toBe("true");
    expect(container.textContent).not.toContain("Try again");
  });
  test("after a refusal no data of the refused Workspace is exposed while revalidating", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") === TEAM, "the team Workspace");

    memberships = [personal];
    holdBootstrap = new Promise<void>(() => undefined);
    await act(async () => {
      (container.querySelector("[data-testid=command]") as unknown as HTMLButtonElement).click();
    });
    await until(() => refusedAt >= 0 && text(container, "status") === "pending", "the revalidation");
    // The re-bootstrap is held: the gate stays pending and nothing of Team is readable.
    for (let tick = 0; tick < 5; tick++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    // Every render and effect from the moment the refusal was known, not from the first pending one.
    const after = seen.slice(refusedAt);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((entry) => entry.scope === null && entry.status === "pending")).toBe(true);
    expect(container.textContent).not.toContain(TEAM);

    let release: () => void = () => {};
    holdBootstrap = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      runtimeRef?.queryClient.invalidateQueries({ queryKey: ["nf", USER, "session", "bootstrap"] });
    });
    release();
    holdBootstrap = null;
    await until(() => text(container, "workspace") === PERSONAL, "the fallback Workspace");
    expectNoUnvalidatedScope();
  });

  test("Clerk loading late issues nothing before it loads and keeps the screen mounted through adoption", async () => {
    auth = { isLoaded: false, userId: null };
    browser.localStorage.setItem(HINT_KEY, TEAM);
    const container = await mount((modules) => <Gates modules={modules} />);
    expect(text(container, "status")).toBe("pending");
    expect(calls).toEqual([]);

    await act(async () => setAuth({ isLoaded: true, userId: USER }));
    await until(() => text(container, "workspace") === TEAM && text(container, "home") === TEAM, "the team Workspace");
    expect(requests("/api/session/bootstrap")).toHaveLength(1);
    // The route read started beside the bootstrap under the (valid) hint; the screen found it.
    expect(requests("/api/home").map((call) => call.workspaceHeader)).toEqual([TEAM]);
    // The screen under the gate rendered from the first frame and never remounted.
    expect(new Set(seen.map((entry) => entry.mount))).toEqual(new Set([1]));
    expectNoUnvalidatedScope();
  });

  test("switching users resets adoption before the new user's Workspace is admitted", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") === TEAM, "the team Workspace");
    const before = calls.length;

    // Clerk answers for the new user before the provider applies it; a child effect
    // that runs first must still see no scope.
    await act(async () => setAuth({ userId: OTHER_USER }));
    await until(() => text(container, "status") === "ready" && seen.at(-1)?.scope?.userId === OTHER_USER, "the other user's Workspace");

    const after = calls.slice(before);
    expect(after[0]?.path).toBe("/api/session/bootstrap");
    // No hint for the new user: the effective (personal) Workspace is adopted, not the old user's.
    expect(after[0]?.hint).toBeNull();
    expect(text(container, "workspace")).toBe(PERSONAL);
    expect(seen.some((entry) => entry.clerkUserId === OTHER_USER && entry.status === "pending")).toBe(true);
    expectNoUnvalidatedScope();
  });

  test("restoring the user after an aborted sign-out adopts again", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") === TEAM, "the team Workspace");
    const runtime = runtimeRef;
    if (!runtime) throw new Error("runtime not captured");
    const before = calls.filter((call) => call.path === "/api/session/bootstrap").length;

    // What the account menu does: clear the session, then put it back when Clerk's sign-out fails.
    await act(async () => runtime.setIdentity(null));
    expect(text(container, "status")).toBe("pending");
    browser.localStorage.clear();
    await act(async () => runtime.setIdentity(USER));
    await until(() => text(container, "status") === "ready", "the re-adopted Workspace");

    expect(calls.filter((call) => call.path === "/api/session/bootstrap").length).toBe(before + 1);
    expect(text(container, "workspace")).toBe(PERSONAL);
    expect(runtime.scope.snapshot().workspaceId).toBe(PERSONAL);
    expectNoUnvalidatedScope();
  });

  test("another tab's hint never exposes an unvalidated scope, while pending or ready", async () => {
    browser.localStorage.setItem(HINT_KEY, PERSONAL);
    let release: () => void = () => {};
    holdBootstrap = new Promise<void>((resolve) => {
      release = resolve;
    });
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => calls.length > 0, "the identity bootstrap");

    // Pending: another tab picks a Workspace this person no longer has.
    await act(async () => storageEvent(HINT_KEY, REMOVED));
    expect(runtimeRef?.scope.snapshot().workspaceId).toBe(REMOVED);
    expect(text(container, "status")).toBe("pending");
    holdBootstrap = null;
    release();
    await until(() => text(container, "workspace") === PERSONAL, "the adopted Workspace");

    // Ready: the same again, then a Workspace this person can open.
    await act(async () => storageEvent(HINT_KEY, REMOVED));
    await until(() => text(container, "workspace") === PERSONAL && runtimeRef?.scope.snapshot().workspaceId === PERSONAL, "the re-adopted Workspace");
    await act(async () => storageEvent(HINT_KEY, TEAM));
    await until(() => text(container, "workspace") === TEAM, "the other tab's valid Workspace");

    expect(exposed()).not.toContain(REMOVED);
    expect(scoped().every((call) => call.workspaceHeader !== REMOVED)).toBe(true);
    expectNoUnvalidatedScope();
  });

  test("a failed refresh after a refusal never re-adopts the refused Workspace, even when a background read landed first", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") === TEAM, "the team Workspace");
    const runtime = runtimeRef;
    if (!runtime) throw new Error("runtime not captured");
    runtime.queryClient.setDefaultOptions({ queries: { retry: false } });

    await act(async () => {
      // A background refresh of the session bootstrap lands in the cache before React renders it.
      await runtime.queryClient.refetchQueries({ queryKey: ["nf", USER, "session", "bootstrap"], exact: true });
      memberships = [personal];
      failBootstrap = true;
      // Then a scoped request is refused, and the re-read after the refusal fails.
      await runtime.transport
        .scoped({ userId: USER, workspaceId: TEAM })
        .json("/api/projects", { method: "POST", json: {} })
        .catch(() => {
          refusedAt = seen.length;
        });
    });
    for (let attempt = 0; attempt < 100 && text(container, "status") !== "failed"; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(text(container, "status")).toBe("failed");
    expect(seen.slice(refusedAt).every((entry) => entry.scope === null)).toBe(true);
  });

  test("a pending bootstrap never undoes another tab's valid selection", async () => {
    browser.localStorage.setItem(HINT_KEY, PERSONAL);
    let release: () => void = () => {};
    holdBootstrap = new Promise<void>((resolve) => {
      release = resolve;
    });
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => requests("/api/session/bootstrap").length > 0, "the identity bootstrap");

    // The request went out with Personal; another tab selects Team before it answers.
    await act(async () => storageEvent(HINT_KEY, TEAM));
    holdBootstrap = null;
    await act(async () => release());
    await until(() => text(container, "status") === "ready", "the adopted Workspace");

    expect(text(container, "workspace")).toBe(TEAM);
    expect(browser.localStorage.getItem(HINT_KEY)).toBe(TEAM);
    expect(exposed()).not.toContain(PERSONAL);
    expectNoUnvalidatedScope();
  });

  test("refusal recovery never undoes another tab's valid selection", async () => {
    memberships = [personal, team, studio];
    browser.localStorage.setItem(HINT_KEY, TEAM);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") === TEAM, "the team Workspace");

    memberships = [personal, studio];
    let release: () => void = () => {};
    holdBootstrap = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      (container.querySelector("[data-testid=command]") as unknown as HTMLButtonElement).click();
    });
    await until(() => refusedAt >= 0 && requests("/api/session/bootstrap").length === 2, "the re-bootstrap");
    // The re-read went out with the refused Team; another tab selects Studio before it answers.
    await act(async () => storageEvent(HINT_KEY, STUDIO));
    holdBootstrap = null;
    await act(async () => release());
    await until(() => text(container, "status") === "ready", "the re-adopted Workspace");

    expect(text(container, "workspace")).toBe(STUDIO);
    expect(browser.localStorage.getItem(HINT_KEY)).toBe(STUDIO);
    expect(seen.slice(refusedAt).some((entry) => entry.scope?.workspaceId === PERSONAL)).toBe(false);
    expectNoUnvalidatedScope();
  });

  test("a sign-out that fails after the account switched does not put the previous user back", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    let modulesRef: Modules | null = null;
    const container = await mount((modules) => {
      modulesRef = modules;
      return <Gates modules={modules} />;
    });
    await until(() => text(container, "workspace") === TEAM, "the team Workspace");
    const runtime = runtimeRef;
    const modules = modulesRef as Modules | null;
    if (!runtime || !modules) throw new Error("runtime not captured");

    let restore: () => void = () => {};
    await act(async () => {
      restore = modules.beginSignOut(runtime);
    });
    // Clerk switches account and the provider applies it; then the first sign-out fails.
    await act(async () => setAuth({ userId: OTHER_USER }));
    await act(async () => restore());
    await until(() => text(container, "status") === "ready" && seen.at(-1)?.scope?.userId === OTHER_USER, "the other user's Workspace");
    expect(runtime.scope.snapshot().userId).toBe(OTHER_USER);
    expectNoUnvalidatedScope();
  });

  test("a sign-out that fails restores the same user", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    let modulesRef: Modules | null = null;
    const container = await mount((modules) => {
      modulesRef = modules;
      return <Gates modules={modules} />;
    });
    await until(() => text(container, "workspace") === TEAM, "the team Workspace");
    const runtime = runtimeRef;
    const modules = modulesRef as Modules | null;
    if (!runtime || !modules) throw new Error("runtime not captured");

    let restore: () => void = () => {};
    await act(async () => {
      restore = modules.beginSignOut(runtime);
    });
    expect(text(container, "status")).toBe("pending");
    await act(async () => restore());
    await until(() => text(container, "status") === "ready", "the re-adopted Workspace");
    expect(runtime.scope.snapshot().userId).toBe(USER);
  });

  test("a Workspace bootstrap refused as paused leaves once", async () => {
    browser.localStorage.setItem(HINT_KEY, PERSONAL);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") === PERSONAL, "the personal Workspace");
    restrictedBootstrap = true;
    ownerCanResolve = true;
    await act(async () => {
      await runtimeRef?.queryClient.invalidateQueries({ queryKey: ["nf", USER, PERSONAL, "workspace", "bootstrap"] });
    });
    await until(() => replaced.length > 0, "the owner's billing redirect");
    for (let tick = 0; tick < 5; tick++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(replaced).toEqual(["/settings/billing"]);
  });

  test("the blocking gate for standalone pages renders its children only once adopted", async () => {
    browser.localStorage.setItem(HINT_KEY, REMOVED);
    const container = await mount((modules) => {
      function Memberships() {
        const { session } = modules.useSessionGate();
        return <p data-testid="memberships">{session.memberships.length}</p>;
      }
      return (
        <modules.SessionGate fallback={<p data-testid="blocked">blocked</p>}>
          <Memberships />
        </modules.SessionGate>
      );
    });
    expect(text(container, "blocked")).toBe("blocked");
    await until(() => text(container, "memberships") === "2", "the adopted session");
    expect(runtimeRef).toBeNull();
    expect(scoped()).toEqual([]);
  });
});

describe("route data beside the bootstrap", () => {
  test("a valid hint starts the route read before the bootstrap answers, and the screen reads it once", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    let release: () => void = () => {};
    holdBootstrap = new Promise<void>((resolve) => {
      release = resolve;
    });
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => requests("/api/home").length > 0, "the route read");
    expect(text(container, "status")).toBe("pending");
    expect(requests("/api/home")[0]?.workspaceHeader).toBe(TEAM);

    holdBootstrap = null;
    await act(async () => release());
    await until(() => text(container, "home") === TEAM, "the screen's data");
    expect(requests("/api/home")).toHaveLength(1);
    expect(requests("/api/session/bootstrap")).toHaveLength(1);
    expectNoUnvalidatedScope();
  });

  test("a stale hint refused before the bootstrap answers neither loops nor shows its data", async () => {
    browser.localStorage.setItem(HINT_KEY, REMOVED);
    let release: () => void = () => {};
    holdBootstrap = new Promise<void>((resolve) => {
      release = resolve;
    });
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => requests("/api/home").length > 0, "the route read");
    // Let the 409 arrive and settle while the bootstrap is held.
    for (let tick = 0; tick < 5; tick++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(cachedWorkspaces().has(REMOVED)).toBe(false);
    expect(requests("/api/session/bootstrap")).toHaveLength(1);

    holdBootstrap = null;
    await act(async () => release());
    await until(() => text(container, "home") === PERSONAL, "the screen's data under the effective Workspace");
    expect(requests("/api/session/bootstrap")).toHaveLength(1);
    expect(requests("/api/home").map((call) => call.workspaceHeader)).toEqual([REMOVED, PERSONAL]);
    expect(replaced).toEqual([]);
    expect(exposed()).not.toContain(REMOVED);
    expectNoUnvalidatedScope();
  });

  test("a stale hint's route read in flight when adoption moves the scope is aborted silently", async () => {
    browser.localStorage.setItem(HINT_KEY, REMOVED);
    let releaseHome: () => void = () => {};
    holdHome = new Promise<void>((resolve) => {
      releaseHome = resolve;
    });
    const errors: unknown[] = [];
    let modulesRef: Modules | null = null;
    const container = await mount((modules) => {
      modulesRef = modules;
      return <Gates modules={modules} />;
    });
    if (!modulesRef || !runtimeRef) throw new Error("runtime not captured");
    const unsubscribe = runtimeRef.queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") errors.push(event.query.queryKey);
    });
    await until(() => aborts.length > 0, "the aborted route read");
    expect(aborts).toEqual(["scope_changed"]);
    holdHome = null;
    releaseHome();
    await until(() => text(container, "home") === PERSONAL, "the screen's data");
    unsubscribe();
    expect(errors).toEqual([]);
    expect(cachedWorkspaces().has(REMOVED)).toBe(false);
    expect(requests("/api/session/bootstrap")).toHaveLength(1);
    expect(replaced).toEqual([]);
    expectNoUnvalidatedScope();
  });

  test("a route read refused as paused does not redirect before adoption", async () => {
    memberships = [personal, paused];
    browser.localStorage.setItem(HINT_KEY, PAUSED);
    let release: () => void = () => {};
    holdBootstrap = new Promise<void>((resolve) => {
      release = resolve;
    });
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => requests("/api/home").length > 0, "the route read");
    for (let tick = 0; tick < 5; tick++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(replaced).toEqual([]);
    expect(cachedWorkspaces().has(PAUSED)).toBe(false);

    holdBootstrap = null;
    await act(async () => release());
    await until(() => replaced.length > 0, "the gate's redirect");
    // Only the gate's answer for a member who cannot view it, never a redirect from the prefetch.
    expect(replaced).toEqual(["/workspace-unavailable"]);
    expect(text(container, "status")).toBe("pending");
    expect(exposed()).toEqual([]);
  });

  test("a first visit with no hint issues no scoped request before adoption", async () => {
    let release: () => void = () => {};
    holdBootstrap = new Promise<void>((resolve) => {
      release = resolve;
    });
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => requests("/api/session/bootstrap").length > 0, "the identity bootstrap");
    for (let tick = 0; tick < 3; tick++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(scoped()).toEqual([]);
    holdBootstrap = null;
    await act(async () => release());
    await until(() => text(container, "home") === PERSONAL, "the screen's data");
    expect(requests("/api/home").map((call) => call.workspaceHeader)).toEqual([PERSONAL]);
    expectNoUnvalidatedScope();
  });

});
