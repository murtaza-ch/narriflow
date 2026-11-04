import { describe, expect, test } from "bun:test";
import { ApiError } from "@narriflow/api-client/core";
import { gateQueries } from "./query-gate";

function query(overrides: { data?: unknown; error?: unknown; isError?: boolean } = {}) {
  const refetched = { count: 0 };
  return {
    data: overrides.data,
    error: overrides.error ?? null,
    isError: overrides.isError ?? false,
    refetch: () => {
      refetched.count += 1;
    },
    refetched,
  };
}

const serverError = new ApiError({ code: "internal_error", message: "boom", status: 500 });

describe("gateQueries", () => {
  test("is loading until every read has data", () => {
    expect(gateQueries([query({ data: 1 }), query()]).status).toBe("loading");
  });

  test("is ready with every result in order", () => {
    const gate = gateQueries([query({ data: "a" }), query({ data: 2 })]);
    expect(gate).toEqual({ status: "ready", data: ["a", 2] });
  });

  test("fails on a read that has nothing to show, and retries only the failed ones", () => {
    const ok = query({ data: 1 });
    const bad = query({ error: serverError, isError: true });
    const gate = gateQueries([ok, bad]);
    expect(gate.status).toBe("failed");
    if (gate.status !== "failed") return;
    expect(gate.error).toBe(serverError);
    gate.retry();
    expect(bad.refetched.count).toBe(1);
    expect(ok.refetched.count).toBe(0);
  });

  test("a failed background refresh keeps the data it has", () => {
    const stale = query({ data: 1, error: serverError, isError: true });
    expect(gateQueries([stale, query({ data: 2 })]).status).toBe("ready");
  });

  test("a failure from a Workspace switch is not shown", () => {
    const superseded = new ApiError({ code: "scope_changed", message: "moved", status: 0 });
    expect(gateQueries([query({ error: superseded, isError: true })]).status).toBe("loading");
  });
});
