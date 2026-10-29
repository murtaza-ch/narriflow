import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type SessionBootstrap,
  type WorkspaceSummary,
  workspaceCapabilities,
} from "@narriflow/validators/api/session";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Runs in its own process (see workspace-query-gate.test.ts): it installs DOM globals.
// The real ApiProvider, runtime, transport and query client run against a fake API.

const browser = new Window({ url: "http://localhost:3000/home" });

const USER = "user_gate";
const PERSONAL = "00000000-0000-4000-8000-000000000001";
const TEAM = "00000000-0000-4000-8000-000000000002";
const REMOVED = "00000000-0000-4000-8000-000000000003";
const PAUSED = "00000000-0000-4000-8000-000000000004";
const HINT_KEY = `narriflow:workspace:${USER}`;

type Member = Pick<WorkspaceSummary, "id" | "name" | "role" | "status" | "isPersonal" | "pricingTier">;
const personal: Member = { id: PERSONAL, name: "Personal", role: "owner", status: "active", isPersonal: true, pricingTier: "free" };
const team: Member = { id: TEAM, name: "Team", role: "owner", status: "active", isPersonal: false, pricingTier: "business" };
const paused: Member = { id: PAUSED, name: "Paused", role: "editor", status: "restricted", isPersonal: false, pricingTier: "business" };

interface Call {
  method: string;
  path: string;
  hint: string | null;
  workspaceHeader: string | null;
}
let calls: Call[];
let memberships: Member[];
let restrictedContent = false;
let ownerCanResolve = false;
const replaced: string[] = [];

const router = { replace: (href: string) => replaced.push(href), push: (href: string) => replaced.push(href) };
mock.module("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/home" }));
mock.module("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, userId: USER, getToken: async () => "session-token" }),
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
  };
  calls.push(call);
  const user = { id: "u1", email: "a@example.test", firstName: "Ada", lastName: null, imageUrl: null };

  if (call.path === "/api/session/bootstrap") {
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

  // Every other route is Workspace-scoped: a selection that is no longer a membership is refused.
  const selected = memberships.find((member) => member.id === call.workspaceHeader);
  if (!selected) {
    return json({ error: "workspace_selection_changed", message: "Your Workspace selection changed.", requestId: "r-409" }, 409);
  }
  if (call.path === "/api/projects/explorer" && restrictedContent) {
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
let runtimeRef: import("@narriflow/api-client").ApiRuntime | null = null;
let probe: { switchTo: (id: string) => Promise<boolean> } | null = null;

async function mount(children: (modules: Awaited<ReturnType<typeof loadAll>>) => ReactNode) {
  const modules = await loadAll();
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root?.render(
      <modules.ChakraProvider value={modules.system}>
        <modules.SessionApiProvider fallback={<p data-testid="pending">pending</p>}>{children(modules)}</modules.SessionApiProvider>
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

function Gates({ modules }: { modules: Awaited<ReturnType<typeof loadAll>> }) {
  const { SessionGate, WorkspaceQueryGate, useSessionGate, useWorkspaceSwitch, useApiRuntime, useWorkspaceScope } = modules;
  function Probe({ workspaceId }: { workspaceId: string }) {
    const gate = useSessionGate();
    const { switchTo } = useWorkspaceSwitch();
    const runtime = useApiRuntime();
    const scope = useWorkspaceScope();
    runtimeRef = runtime;
    probe = { switchTo };
    return (
      <div>
        <p data-testid="workspace">{workspaceId}</p>
        <p data-testid="changed">{String(gate.selectionChanged)}</p>
        <button
          type="button"
          data-testid="command"
          onClick={() => {
            if (scope) void runtime.transport.scoped(scope).json("/api/projects", { method: "POST", json: {} }).catch(() => undefined);
          }}
        >
          command
        </button>
      </div>
    );
  }
  return (
    <SessionGate fallback={<p data-testid="pending">pending</p>}>
      <WorkspaceQueryGate fallback={<p data-testid="pending">pending</p>}>
        {(bootstrap) => <Probe workspaceId={bootstrap.workspace.id} />}
      </WorkspaceQueryGate>
    </SessionGate>
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
  browser.localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
});

afterAll(() => browser.close());

const scoped = () => calls.filter((call) => call.workspaceHeader !== null);

describe("session and Workspace gates", () => {
  test("a removed saved Workspace falls back to the personal one before any scoped request", async () => {
    browser.localStorage.setItem(HINT_KEY, REMOVED);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") !== null, "the Workspace bootstrap");

    expect(text(container, "workspace")).toBe(PERSONAL);
    expect(text(container, "changed")).toBe("true");
    expect(calls[0]?.path).toBe("/api/session/bootstrap");
    expect(calls[0]?.hint).toBe(REMOVED);
    expect(scoped().length).toBeGreaterThan(0);
    expect(scoped().every((call) => call.workspaceHeader === PERSONAL)).toBe(true);
    expect(browser.localStorage.getItem(HINT_KEY)).toBe(PERSONAL);
  });

  test("a valid saved Workspace is kept without announcing a change", async () => {
    browser.localStorage.setItem(HINT_KEY, TEAM);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => text(container, "workspace") !== null, "the Workspace bootstrap");
    expect(text(container, "workspace")).toBe(TEAM);
    expect(text(container, "changed")).toBe("false");
  });

  test("a member of a paused Workspace is sent to the page outside the shell without reading its content", async () => {
    memberships = [personal, paused];
    browser.localStorage.setItem(HINT_KEY, PAUSED);
    const container = await mount((modules) => <Gates modules={modules} />);
    await until(() => replaced.length > 0, "the recovery redirect");
    expect(replaced).toEqual(["/workspace-unavailable"]);
    expect(text(container, "workspace")).toBeNull();
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
  });
});
