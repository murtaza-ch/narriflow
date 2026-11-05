import { afterEach, describe, expect, test } from "bun:test";
import { installFailureReporter } from "./log-failure";
import { evaluateOperationalHealth, pingHeartbeat, runOperationalHealthCheck, type OperationalSnapshot } from "./operational-health";
import { withServiceEnvironment } from "./runtime-environment";

const healthy: OperationalSnapshot = { deadLettered: 0, oldestUndeliveredSeconds: 0, oldestRenderWaitSeconds: 0, expiredAttempts: 0, failedRenders: 0, finishedRenders: 40 };
const keys = (snapshot: Partial<OperationalSnapshot>) => evaluateOperationalHealth({ ...healthy, ...snapshot }).map(alert => `${alert.severity}:${alert.key}`);

describe("evaluateOperationalHealth", () => {
  test("a healthy system raises nothing", () => expect(keys({})).toEqual([]));
  test("work that stopped moving is critical", () => {
    expect(keys({ deadLettered: 1 })).toEqual(["critical:dispatch_dead_lettered"]);
    expect(keys({ oldestUndeliveredSeconds: 4501 })).toEqual(["critical:dispatch_undelivered"]);
    expect(keys({ oldestRenderWaitSeconds: 3601 })).toEqual(["critical:render_queue_stuck"]);
  });
  test("a dispatch the next reconcile can still repair and a queue on a busy day stay quiet", () => {
    expect(keys({ oldestUndeliveredSeconds: 4500, oldestRenderWaitSeconds: 3600 })).toEqual([]);
  });
  test("render failures need both a count and a rate, so one bad clip stays quiet", () => {
    expect(keys({ failedRenders: 2, finishedRenders: 2 })).toEqual([]);
    expect(keys({ failedRenders: 3, finishedRenders: 100 })).toEqual([]);
    expect(keys({ failedRenders: 3, finishedRenders: 10 })).toEqual(["warning:render_failures"]);
  });
  test("expired attempts warn from three", () => {
    expect(keys({ expiredAttempts: 2 })).toEqual([]);
    expect(keys({ expiredAttempts: 3 })).toEqual(["warning:attempts_expired"]);
  });
});

function recorder(outcome: "ok" | "throw" = "ok") {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const request = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body });
    if (outcome === "throw") throw new Error("network");
    return new Response("ok");
  }) as unknown as typeof fetch;
  return { calls, request };
}
const database = (row: OperationalSnapshot | Error) => ({ $queryRaw: async () => { if (row instanceof Error) throw row; return [row]; } }) as never;
const heartbeat = "https://example.test/heartbeat/token";
const inScope = (run: () => Promise<void>) => withServiceEnvironment({ HEARTBEAT_URL: heartbeat }, run);

describe("runOperationalHealthCheck", () => {
  afterEach(() => installFailureReporter(undefined));
  test("healthy pings success", async () => {
    const { calls, request } = recorder();
    await inScope(() => runOperationalHealthCheck({ database: database(healthy), request }));
    expect(calls).toEqual([{ url: heartbeat, method: "GET", body: undefined }]);
  });
  test("a warning goes to the error feed and does not open an incident", async () => {
    const { calls, request } = recorder();
    const reported: string[] = [];
    installFailureReporter((message, failure) => reported.push(`${message}:${failure.code}`));
    await inScope(() => runOperationalHealthCheck({ database: database({ ...healthy, expiredAttempts: 5 }), request }));
    expect(calls[0]?.url).toBe(heartbeat);
    expect(reported).toEqual(["operational_warning:attempts_expired"]);
  });
  test("critical opens an incident that says what is wrong", async () => {
    const { calls, request } = recorder();
    await inScope(() => runOperationalHealthCheck({ database: database({ ...healthy, deadLettered: 2 }), request }));
    expect(calls[0]?.url).toBe(`${heartbeat}/fail`);
    expect(calls[0]?.body).toContain("2 dispatches dead-lettered");
  });
  test("a check that cannot run is an incident, never a silent success", async () => {
    const { calls, request } = recorder();
    await inScope(() => runOperationalHealthCheck({ database: database(new Error("database down")), request }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${heartbeat}/fail`);
  });
  test("without a heartbeat configured it does nothing and does not throw", async () => {
    const { calls, request } = recorder();
    await withServiceEnvironment({}, () => runOperationalHealthCheck({ database: database(healthy), request }));
    expect(calls).toEqual([]);
  });
});

test("a heartbeat outage never breaks the cron", async () => {
  const { request } = recorder("throw");
  await expect(pingHeartbeat(heartbeat, null, request)).resolves.toBeUndefined();
});
