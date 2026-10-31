import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApiRuntime } from "@narriflow/api-client";
import type { ProjectDetail } from "@narriflow/api-client/projects";

const browser = new Window({ url: "http://localhost:3000/upload" });
const scope = { userId: "user_test", workspaceId: "11111111-1111-4111-8111-111111111111" };
const projectId = "22222222-2222-4222-8222-222222222222";
const navigations: string[] = [];
const router = { replace: (href: string) => navigations.push(href) };
let runtime: ApiRuntime;
let body: ProjectDetail;
let streamEnabled = false;
let reads = 0;
let readDelayMs = 0;

// Presentation is irrelevant to the transition; the component and API query are real.
const block = ({ children, role, ...props }: { children?: ReactNode; role?: string; [key: string]: unknown }) =>
  createElement("div", { role, ...Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith("aria-") || key.startsWith("data-"))) }, children);
mock.module("@chakra-ui/react", () => ({ Box: block, Stack: block, HStack: block, Text: block }));
mock.module("@narriflow/ui/components/spinner", () => ({ Spinner: () => null }));
mock.module("@narriflow/ui/components/button", () => ({ Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => createElement("button", { type: "button", onClick }, children) }));
mock.module("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => router }));
mock.module("@/app/_components/api-provider", () => ({ useApiRuntime: () => runtime }));
mock.module("../_lib/intake-context", () => ({ useIntake: () => ({ transport: runtime.transport, scope }) }));
let ImportProgress: typeof import("./import-progress").ImportProgress;
let QueryClientProvider: typeof import("@tanstack/react-query").QueryClientProvider;
let root: Root | null = null;

function data(statuses: string[], runStatus = "running"): ProjectDetail {
  return {
    snapshot: { project: { id: projectId, title: "Test import", ingestStatus: "ready" }, activeRun: { stage: "clip_rendering", status: runStatus, progress: 50 }, lastSeq: 5 },
    transcript: { data: { status: "completed" } },
    clips: statuses.map((status) => ({ renderVariants: [{ status, hasAsset: status === "completed" }] })),
  } as unknown as ProjectDetail;
}

beforeAll(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const progress = await import("@narriflow/api-client/progress");
  mock.module("@narriflow/api-client/progress", () => ({ ...progress, useProgressStream: (_runtime: unknown, _scope: unknown, _id: unknown, options: { enabled: boolean }) => { streamEnabled = options.enabled; } }));
  const { createApiRuntime } = await import("@narriflow/api-client");
  runtime = createApiRuntime({ baseUrl: "http://api.test", getToken: async () => "token", fetch: (async () => {
    reads += 1;
    if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "X-Workspace-Id": scope.workspaceId } });
  }) as typeof fetch });
  runtime.setIdentity(scope.userId);
  runtime.selectWorkspace(scope.workspaceId);
  ({ QueryClientProvider } = await import("@tanstack/react-query"));
  ({ ImportProgress } = await import("./import-progress"));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  runtime.queryClient.clear();
  browser.document.body.replaceChildren();
  navigations.length = 0;
  reads = 0;
  readDelayMs = 0;
});
afterAll(() => browser.close());
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
async function render() {
  root = createRoot(browser.document.body.appendChild(browser.document.createElement("div")) as unknown as HTMLElement);
  await act(async () => root!.render(<QueryClientProvider client={runtime.queryClient}><ImportProgress projectId={projectId} /></QueryClientProvider>));
  await settle();
}
async function reread() {
  await act(async () => { await runtime.queryClient.invalidateQueries(); });
  await settle();
}

test("upload progress waits through partial readiness and opens results only after batch settlement", async () => {
  body = data(["completed", "rendering"]);
  await render();
  expect(browser.document.body.textContent).toContain("1 of 2 clips ready");
  expect(navigations).toEqual([]);
  expect(streamEnabled).toBe(true);
  body = data(["completed", "completed"]);
  await reread();
  expect(navigations).toEqual([]);
  body = data(["completed", "completed"], "completed");
  await reread();
  expect(navigations).toEqual([`/projects/${projectId}`]);
  expect(streamEnabled).toBe(false);
});

test("without stream events polling still completes the import", async () => {
  body = data(["rendering"]);
  await render();
  body = data(["completed"], "completed");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5_200)); });
  expect(reads).toBeGreaterThan(1);
  expect(navigations).toEqual([`/projects/${projectId}`]);
}, 10_000);

test("a partial batch offers recovery without automatically opening the project", async () => {
  body = data(["completed", "failed"], "partial");
  await render();
  expect(navigations).toEqual([]);
  expect(browser.document.querySelector("a")?.getAttribute("href")).toBe(`/projects/${projectId}`);
  expect(browser.document.body.textContent).toContain("Review and retry");
});

test("a cached completed project cannot bypass the fresh readiness check", async () => {
  const { createProjectsClient, projectQueries } = await import("@narriflow/api-client/projects");
  const client = createProjectsClient(runtime.transport.scoped(scope));
  runtime.queryClient.setQueryData(projectQueries.detail(client, scope, projectId).queryKey, data(["completed"], "completed"));
  body = data(["rendering"]);
  readDelayMs = 120;
  await render();
  expect(navigations).toEqual([]);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
  expect(navigations).toEqual([]);
  expect(browser.document.body.textContent).toContain("Rendering your clips");
});
