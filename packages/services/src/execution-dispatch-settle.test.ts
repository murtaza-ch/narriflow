import { describe, expect, test } from "bun:test";
import { ExecutionDispatchPendingError } from "./execution-dispatch";
import { settleExecutionDispatches } from "./execution-dispatch-runtime";

const pending = () => new ExecutionDispatchPendingError(new Date("2026-11-05T20:00:30.000Z"));

function harness(outcomes: Array<Error | null>) {
  const waits: number[] = [];
  let calls = 0;
  return {
    waits,
    calls: () => calls,
    dependencies: {
      deliver: async () => { const outcome = outcomes[Math.min(calls++, outcomes.length - 1)]; if (outcome) throw outcome; },
      wait: async (ms: number) => { waits.push(ms); },
    },
  };
}

describe("settleExecutionDispatches", () => {
  test("a dispatch delivered first time never waits", async () => {
    const run = harness([null]);
    await settleExecutionDispatches(["a"], run.dependencies);
    expect(run.calls()).toBe(1);
    expect(run.waits).toEqual([]);
  });
  test("a request outlasts a lease another worker holds briefly", async () => {
    const run = harness([pending(), pending(), null]);
    await settleExecutionDispatches(["a"], run.dependencies);
    expect(run.calls()).toBe(3);
    expect(run.waits).toHaveLength(2);
  });
  test("a lease that never clears still reports pending, within about two seconds", async () => {
    const run = harness([pending()]);
    await expect(settleExecutionDispatches(["a"], run.dependencies)).rejects.toBeInstanceOf(ExecutionDispatchPendingError);
    expect(run.calls()).toBe(5);
    expect(run.waits.reduce((sum, ms) => sum + ms, 0)).toBe(2_000);
  });
  test("a real delivery failure is not retried", async () => {
    const run = harness([new Error("scheduler_unavailable")]);
    await expect(settleExecutionDispatches(["a"], run.dependencies)).rejects.toThrow("scheduler_unavailable");
    expect(run.calls()).toBe(1);
    expect(run.waits).toEqual([]);
  });
});
