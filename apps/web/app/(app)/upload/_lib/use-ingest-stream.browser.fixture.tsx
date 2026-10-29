import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApiRuntime } from "@narriflow/api-client";
import type { WorkflowStageUpdatedEvent } from "@narriflow/validators";

const browser = new Window({ url: "http://localhost:3000/upload" });
const USER = "user_test";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const scope = { userId: USER, workspaceId: WORKSPACE };

let snapshot: { ingestStatus: string; ingestErrorCode: string | null; lastSeq: number } = { ingestStatus: "queued", ingestErrorCode: null, lastSeq: 0 };
let snapshotReads = 0;
let readDelayMs = 0;
const fakeFetch = (async () => {
  snapshotReads += 1;
  // The server answers with what it knew when the request arrived.
  const body = JSON.stringify({ project: { ingestStatus: snapshot.ingestStatus, ingestErrorCode: snapshot.ingestErrorCode }, progress: null, activeRun: null, lastSeq: snapshot.lastSeq });
  if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
  return new Response(
    body,
    { status: 200, headers: { "Content-Type": "application/json", "X-Workspace-Id": WORKSPACE } },
  );
}) as unknown as typeof fetch;

// The runtime (and React Query, which only schedules refetch intervals in a browser) loads after the DOM globals exist.
let runtime: ApiRuntime;

// The shared stream is replaced by a handle the test drives; its join options are recorded.
const stream: { enabled: boolean; sinceSeq: number; onEvent: (event: WorkflowStageUpdatedEvent) => void } = {
  enabled: false,
  sinceSeq: -1,
  onEvent: () => undefined,
};
mock.module("@/app/_components/api-provider", () => ({ useApiRuntime: () => runtime }));
let useIngestStream: typeof import("./use-ingest-stream").useIngestStream;
let IntakeProvider: typeof import("./intake-context").IntakeProvider;
let QueryClientProvider: typeof import("@tanstack/react-query").QueryClientProvider;
let root: Root | null = null;

beforeAll(async () => {
  Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement,
    Element: browser.Element, Node: browser.Node, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const realProgress = await import("@narriflow/api-client/progress");
  mock.module("@narriflow/api-client/progress", () => ({
    ...realProgress,
    useProgressStream: (_runtime: unknown, _scope: unknown, _project: unknown, options: typeof stream) => {
      stream.enabled = options.enabled ?? true;
      stream.sinceSeq = options.sinceSeq ?? 0;
      stream.onEvent = options.onEvent;
    },
  }));
  const { createApiRuntime } = await import("@narriflow/api-client");
  runtime = createApiRuntime({ baseUrl: "http://api.test", getToken: async () => "token", fetch: fakeFetch });
  runtime.setIdentity(USER);
  runtime.selectWorkspace(WORKSPACE);
  ({ useIngestStream } = await import("./use-ingest-stream"));
  ({ IntakeProvider } = await import("./intake-context"));
  ({ QueryClientProvider } = await import("@tanstack/react-query"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
  runtime.queryClient.clear();
  snapshot = { ingestStatus: "queued", ingestErrorCode: null, lastSeq: 0 };
  snapshotReads = 0;
  readDelayMs = 0;
  stream.enabled = false;
  stream.sinceSeq = -1;
});
afterAll(() => browser.close());

type Initial = { ingestStatus: "queued" | "failed"; errorCode: string | null };
const seen: { current: { ingestStatus: string; errorCode: string | null } } = { current: { ingestStatus: "", errorCode: null } };

function Probe({ initial, attempt, pollMs }: { initial: Initial; attempt: number; pollMs: number }) {
  seen.current = useIngestStream(PROJECT, initial, { attempt, pollMs });
  return null;
}

async function render(initial: Initial, attempt: number, pollMs = 60_000) {
  if (!root) root = createRoot(browser.document.body.appendChild(browser.document.createElement("div")) as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <QueryClientProvider client={runtime.queryClient}>
        <IntakeProvider scope={scope}>
          <Probe initial={initial} attempt={attempt} pollMs={pollMs} />
        </IntakeProvider>
      </QueryClientProvider>,
    );
  });
}

const stage = (seq: number, stageName: string, status: string, errorCode: string | null = null) =>
  ({
    event: "workflow.stage.updated", projectId: PROJECT, workflowRunId: "33333333-3333-4333-8333-333333333333",
    seq, stage: stageName, status, progress: 0, errorCode, emittedAt: "2030-01-01T00:00:00.000Z",
  }) as unknown as WorkflowStageUpdatedEvent;

const emit = (event: WorkflowStageUpdatedEvent) => act(async () => stream.onEvent(event));
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });

test("every accepted retry resets a streamed failure and rejoins after the newest applied event", async () => {
  const queued: Initial = { ingestStatus: "queued", errorCode: null };
  await render(queued, 0);
  expect(stream.enabled).toBe(true);

  await emit(stage(4, "ingest_downloading", "running"));
  await emit(stage(5, "ingest_downloading", "failed", "download_failed"));
  expect(seen.current).toEqual({ ingestStatus: "failed", errorCode: "download_failed" });
  expect(stream.enabled).toBe(false);

  // Retry hands over a new object with the very same queued/null values.
  await render({ ...queued }, 1);
  expect(seen.current).toEqual({ ingestStatus: "queued", errorCode: null });
  expect(stream.enabled).toBe(true);
  expect(stream.sinceSeq).toBe(5);

  await emit(stage(8, "ingest_normalizing", "failed", "normalize_failed"));
  expect(seen.current.ingestStatus).toBe("failed");
  await render({ ...queued }, 2);
  expect(seen.current).toEqual({ ingestStatus: "queued", errorCode: null });
  expect(stream.enabled).toBe(true);
  expect(stream.sinceSeq).toBe(8);
});

test("without any stream events the polled snapshot settles the import and stops polling", async () => {
  await render({ ingestStatus: "queued", errorCode: null }, 0, 40);
  await settle();
  expect(seen.current.ingestStatus).toBe("queued");

  snapshot = { ingestStatus: "downloading", ingestErrorCode: null, lastSeq: 3 };
  await settle();
  await settle();
  expect(seen.current.ingestStatus).toBe("downloading");

  snapshot = { ingestStatus: "failed", ingestErrorCode: "download_failed", lastSeq: 6 };
  await settle();
  await settle();
  expect(seen.current).toEqual({ ingestStatus: "failed", errorCode: "download_failed" });
  expect(stream.enabled).toBe(false);
  const reads = snapshotReads;
  await settle();
  await settle();
  expect(snapshotReads).toBe(reads);
});

test("a snapshot read still in flight when a retry is accepted never brings the old failure back", async () => {
  // A slow poll starts while the server already holds the failure; the stream reports it first and the person retries.
  snapshot = { ingestStatus: "failed", ingestErrorCode: "download_failed", lastSeq: 5 };
  readDelayMs = 150;
  await render({ ingestStatus: "queued", errorCode: null }, 0, 1_000);
  await emit(stage(5, "ingest_downloading", "failed", "download_failed"));
  expect(seen.current.ingestStatus).toBe("failed");
  // The server accepted the retry before answering the stale poll.
  snapshot = { ingestStatus: "queued", ingestErrorCode: null, lastSeq: 6 };
  readDelayMs = 0;
  await render({ ingestStatus: "queued", errorCode: null }, 1, 1_000);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(seen.current).toEqual({ ingestStatus: "queued", errorCode: null });
  expect(stream.enabled).toBe(true);
});
