import type { ProgressSocketOptions, StreamEnd } from "./socket";
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import type { WorkflowStageUpdatedEvent } from "@narriflow/validators/api/progress";
import { fakeTransport } from "./test-support";
import { ApiError, scopedKey } from "../core";
import { type ProgressMessage, decodeProgressMessage } from "./events";
import { createProgressHub } from "./hub";

const SCOPE = { userId: "user_1", workspaceId: "ws_1" };
const PROJECT = "50000000-0000-4000-8000-000000000001";
const RUN = "60000000-0000-4000-8000-000000000001";

function event(seq: number, over: Partial<WorkflowStageUpdatedEvent> = {}): WorkflowStageUpdatedEvent {
  return {
    event: "workflow.stage.updated",
    projectId: PROJECT,
    workflowRunId: RUN,
    seq,
    stage: "clip_rendering",
    status: "running",
    progress: 10,
    errorCode: null,
    emittedAt: "2026-10-29T00:00:00.000Z",
    ...over,
  };
}

interface FakeRun {
  options: ProgressSocketOptions;
  end(end: StreamEnd): void;
  push(message: ProgressMessage): Promise<void>;
  open(): void;
}

function harness(over: { now?: () => number; lingerMs?: number; throttleMs?: number } = {}) {
  const runs: FakeRun[] = [];
  const queryClient = new QueryClient();
  const invalidated: string[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: { queryKey?: readonly unknown[] }) => {
    invalidated.push(JSON.stringify(filters?.queryKey));
    return original(filters as never);
  }) as typeof queryClient.invalidateQueries;
  const hub = createProgressHub({
    transport: fakeTransport(),
    queryClient,
    runStream: (async (options: ProgressSocketOptions) => {
      return new Promise<StreamEnd>((resolve) => {
        runs.push({
          options,
          end: resolve,
          push: async (message) => {
            await options.onEvent(message);
          },
          open: () => options.onStatus?.({ state: "open", attempt: 0 }),
        });
        options.signal.addEventListener("abort", () => resolve({ reason: "aborted" }), { once: true });
      });
    }) as never,
    now: over.now,
    lingerMs: over.lingerMs ?? 20,
    throttleMs: over.throttleMs ?? 50,
  });
  const clipKey = JSON.stringify(scopedKey(SCOPE, "clips", "list", PROJECT));
  return { hub, runs, queryClient, invalidated, clipKey };
}

const live = (seq: number, over: Partial<WorkflowStageUpdatedEvent> = {}): ProgressMessage => ({
  kind: "event",
  event: event(seq, over),
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("progress hub", () => {
  test("three consumers share one connection to the API path and it closes after the last leaves", async () => {
    const { hub, runs } = harness();
    const seen: number[][] = [[], [], []];
    const offs = [0, 1, 2].map((i) =>
      hub.subscribe(SCOPE, PROJECT, { sinceSeq: 5, onEvent: (e) => seen[i]?.push(e.seq) }),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.options.projectId).toBe(PROJECT);
    expect(runs[0]?.options.initialCursor).toBe(5);
    await runs[0]?.push(live(6));
    expect(seen).toEqual([[6], [6], [6]]);

    offs[0]?.();
    offs[1]?.();
    await sleep(40);
    expect(runs[0]?.options.signal.aborted).toBe(false);
    offs[2]?.();
    await sleep(40);
    expect(runs[0]?.options.signal.aborted).toBe(true);
  });

  test("a consumer that leaves and returns within the linger window keeps the connection", async () => {
    const { hub, runs } = harness({ lingerMs: 50 });
    hub.subscribe(SCOPE, PROJECT, {})();
    await sleep(10);
    hub.subscribe(SCOPE, PROJECT, {});
    await sleep(80);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.options.signal.aborted).toBe(false);
  });

  test("different Workspaces and Projects never share a connection", () => {
    const { hub, runs } = harness();
    hub.subscribe(SCOPE, PROJECT, {});
    hub.subscribe({ ...SCOPE, workspaceId: "ws_2" }, PROJECT, {});
    hub.subscribe(SCOPE, "other", {});
    expect(runs).toHaveLength(3);
  });

  test("a late consumer replays what the buffer holds after its cursor, once, in order", async () => {
    const { hub, runs } = harness();
    hub.subscribe(SCOPE, PROJECT, { sinceSeq: 0 });
    for (const seq of [1, 2, 3]) await runs[0]?.push(live(seq));
    const late: number[] = [];
    hub.subscribe(SCOPE, PROJECT, { sinceSeq: 1, onEvent: (e) => late.push(e.seq) });
    await runs[0]?.push(live(4));
    expect(late).toEqual([2, 3, 4]);
    expect(runs).toHaveLength(1);
  });

  test("a consumer needing events older than the connection started from reconnects from its cursor", async () => {
    const { hub, runs } = harness();
    const first: number[] = [];
    hub.subscribe(SCOPE, PROJECT, { sinceSeq: 10, onEvent: (e) => first.push(e.seq) });
    await runs[0]?.push(live(11));
    const second: number[] = [];
    hub.subscribe(SCOPE, PROJECT, { sinceSeq: 0, onEvent: (e) => second.push(e.seq) });
    expect(runs).toHaveLength(2);
    expect(runs[0]?.options.signal.aborted).toBe(true);
    expect(runs[1]?.options.initialCursor).toBe(0);
    for (const seq of [1, 2, 11, 12]) await runs[1]?.push(live(seq));
    expect(second).toEqual([1, 2, 11, 12]);
    expect(first).toEqual([11, 12]); // the replay of 11 is not repeated to the first consumer
  });

  test("onOpen reports the first open and each reconnect", () => {
    const { hub, runs } = harness();
    const opens: boolean[] = [];
    hub.subscribe(SCOPE, PROJECT, { onOpen: (info) => opens.push(info.reconnected) });
    runs[0]?.open();
    runs[0]?.open();
    expect(opens).toEqual([false, true]);
  });

  test("non-terminal bursts invalidate behind a leading + one trailing throttle", async () => {
    let clock = 10_000;
    const { hub, runs, invalidated, clipKey } = harness({ now: () => clock, throttleMs: 50 });
    hub.subscribe(SCOPE, PROJECT, {});
    const count = () => invalidated.filter((key) => key === clipKey).length;
    await runs[0]?.push(live(1));
    expect(count()).toBe(1); // leading
    clock += 10;
    await runs[0]?.push(live(2));
    await runs[0]?.push(live(3));
    expect(count()).toBe(1);
    await sleep(80);
    expect(count()).toBe(2); // one trailing for the whole burst
  });

  test("a burst of render events refetches an open export page once behind the throttle, and a terminal one at once", async () => {
    const clock = 10_000;
    const { hub, runs, queryClient } = harness({ now: () => clock, throttleMs: 5_000 });
    const fetches = { mine: 0, other: 0 };
    const observe = (project: string, counter: keyof typeof fetches) =>
      new QueryObserver(queryClient, {
        queryKey: scopedKey(SCOPE, "exports", "detail", { id: project, clipId: "c1", exportId: "e1" }) as unknown[],
        queryFn: async () => {
          fetches[counter] += 1;
          return { n: fetches[counter] };
        },
      }).subscribe(() => undefined);
    const stops = [observe(PROJECT, "mine"), observe("50000000-0000-4000-8000-000000000002", "other")];
    await sleep(5);
    hub.subscribe(SCOPE, PROJECT, {});
    for (let seq = 1; seq <= 30; seq += 1) await runs[0]?.push(live(seq));
    await sleep(10);
    expect(fetches).toEqual({ mine: 2, other: 1 }); // the first read plus one leading refetch for the whole burst
    await runs[0]?.push(live(31, { status: "completed" }));
    await sleep(10);
    expect(fetches).toEqual({ mine: 3, other: 2 }); // a terminal outcome refreshes every export read, once
    for (const stop of stops) stop();
  });

  test("a terminal outcome invalidates once, even when it is replayed or arrives with others", async () => {
    const { hub, runs, invalidated } = harness();
    hub.subscribe(SCOPE, PROJECT, {});
    const usage = JSON.stringify(scopedKey(SCOPE, "workspace", "usage"));
    const done = live(4, { status: "completed" });
    await runs[0]?.push(done);
    await runs[0]?.push(live(5, { status: "failed", stage: "dubbing" }));
    await runs[0]?.push(done); // replay after a reconnect
    await sleep(5);
    expect(invalidated.filter((key) => key === usage)).toHaveLength(1);
    await runs[0]?.push(live(6, { status: "partial", workflowRunId: "70000000-0000-4000-8000-000000000001" }));
    await sleep(5);
    expect(invalidated.filter((key) => key === usage)).toHaveLength(2);
  });

  test("an expired token reconnects quietly; any other revocation closes, tells consumers and is not retried", async () => {
    const { hub, runs } = harness();
    const revoked: string[] = [];
    hub.subscribe(SCOPE, PROJECT, { onRevoked: (c) => revoked.push(c.error) });
    await runs[0]?.push({ kind: "revoked", control: { error: "authentication_required" } });
    expect(revoked).toEqual([]);
    expect(runs[0]?.options.signal.aborted).toBe(false);

    await runs[0]?.push({ kind: "revoked", control: { error: "workspace_restricted" } });
    expect(revoked).toEqual(["workspace_restricted"]);
    expect(runs[0]?.options.signal.aborted).toBe(true);
    // A later subscribe opens a new connection rather than reusing the dead one.
    hub.subscribe(SCOPE, PROJECT, {});
    expect(runs).toHaveLength(2);
  });

  test("a fatal refusal is reported to every consumer and frees the slot", async () => {
    const { hub, runs } = harness();
    const errors: string[] = [];
    hub.subscribe(SCOPE, PROJECT, { onFatal: (e) => errors.push(e.code) });
    hub.subscribe(SCOPE, PROJECT, { onFatal: (e) => errors.push(e.code) });
    runs[0]?.end({
      reason: "fatal",
      error: new ApiError({ code: "project_not_found", message: "gone", status: 404 }),
    });
    await sleep(5);
    expect(errors).toEqual(["project_not_found", "project_not_found"]);
    hub.subscribe(SCOPE, PROJECT, {});
    expect(runs).toHaveLength(2);
  });

  test("a throwing consumer does not stop the others or the stream", async () => {
    const { hub, runs } = harness();
    const seen: number[] = [];
    hub.subscribe(SCOPE, PROJECT, {
      onEvent: () => {
        throw new Error("bug");
      },
    });
    hub.subscribe(SCOPE, PROJECT, { onEvent: (e) => seen.push(e.seq) });
    await runs[0]?.push(live(1));
    await runs[0]?.push(live(2));
    expect(seen).toEqual([1, 2]);
  });

  test("the buffer is bounded: past its limit a consumer from an older cursor reconnects instead of reading a hole", async () => {
    const { hub, runs } = harness();
    hub.subscribe(SCOPE, PROJECT, { sinceSeq: 0 });
    for (let seq = 1; seq <= 600; seq += 1) await runs[0]?.push(live(seq));
    const got: number[] = [];
    hub.subscribe(SCOPE, PROJECT, { sinceSeq: 10, onEvent: (e) => got.push(e.seq) });
    expect(runs).toHaveLength(2); // seq 10 is below the buffer floor
    expect(runs[1]?.options.initialCursor).toBe(10);
  });
});

test("a healthy shared connection reports status to late subscribers and reset refreshes snapshots", async () => {
  const { hub, runs, invalidated } = harness();
  hub.subscribe(SCOPE, PROJECT, {}); runs[0]?.open();
  const statuses: string[] = [];
  hub.subscribe(SCOPE, PROJECT, { onStatus: (status) => statuses.push(status.state) });
  expect(statuses).toEqual(["open"]);
  await runs[0]?.push({ kind: "reset", cursor: 99 });
  expect(invalidated.length).toBeGreaterThan(0);
});

describe("decodeProgressMessage", () => {
  test("validates scoped event frames and reset controls", () => {
    expect(decodeProgressMessage({ type: "event", event: event(3) })).toMatchObject({ kind: "event", event: { seq: 3 } });
    expect(decodeProgressMessage({ type: "reset", cursor: 99 })).toEqual({ kind: "reset", cursor: 99 });
    expect(decodeProgressMessage({ type: "connected", projectId: PROJECT, cursor: 0 })).toBeNull();
    expect(() => decodeProgressMessage({ type: "event", event: { seq: "x" } })).toThrow();
    expect(decodeProgressMessage({ type: "revoked", control: { error: "project_inaccessible", private: "redacted" } })).toEqual({ kind: "revoked", control: { error: "project_inaccessible" } });
  });
});
