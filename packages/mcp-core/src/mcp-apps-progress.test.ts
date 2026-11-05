import { bindServiceTestEnvironment } from "@narriflow/services/runtime-test-support";
import { describe, expect, test } from "bun:test";
import { isStaleProgressReplay, narriflowProgressRequest, progressIsLive, progressRefreshDelayMs } from "./mcp-apps/v2/progress";
import { progressView } from "./mcp-apps/v2/views";

describe("App operation progress", () => {
  test("refreshes accepted work through its exact Operation Status", bindServiceTestEnvironment(() => {
    expect(narriflowProgressRequest({ export: { exportId: "export" }, operation: { kind: "export", id: "export" } }, { workspaceId: "workspace", projectId: "project", clipId: "clip" }, {}))
      .toEqual({ name: "narriflow_get_operation", arguments: { workspaceId: "workspace", operation: { kind: "export", id: "export" } } });
    expect(narriflowProgressRequest({ operation: { kind: "generation", id: "run" }, projectId: "project" }, { workspaceId: "workspace" }, {}))
      .toEqual({ name: "narriflow_get_operation", arguments: { workspaceId: "workspace", operation: { kind: "generation", id: "run" } } });
  }));
  test("uses safe operation metadata when Tasks replaces the initial result", bindServiceTestEnvironment(() => {
    expect(narriflowProgressRequest({}, {}, { "narriflow/operation": { workspaceId: "workspace", projectId: "project", domainId: "job", domainKind: "intake" } }))
      .toEqual({ name: "narriflow_get_operation", arguments: { workspaceId: "workspace", operation: { kind: "intake", id: "job" } } });
    expect(() => narriflowProgressRequest({}, {}, { "narriflow/operation": { domainKind: "export", projectId: "project" } })).toThrow("Operation status is unavailable");
  }));
  test("a Project snapshot refreshes itself and never stands in for accepted work", bindServiceTestEnvironment(() => {
    expect(narriflowProgressRequest({ project: { workspaceId: "workspace", projectId: "project" } }, {}, {})).toEqual({ name: "narriflow_get_project", arguments: { workspaceId: "workspace", projectId: "project" } });
  }));
  test("renders Operation Status with partial outcomes", bindServiceTestEnvironment(() => {
    const view = progressView({ operation: { kind: "generation", id: "run" }, state: "partial", stage: "rendering", progress: 1,
      items: [{ kind: "clip", id: "a", state: "completed" }, { kind: "clip", id: "b", state: "failed" }] });
    expect(view.badge).toBe("Partial");
    expect(view.html).toContain("1 of 2 clips finished");
  }));
  test("a card keeps reading while work can change, and stops when it settles", () => {
    expect(progressIsLive({ export: { status: "queued" } })).toBe(true);
    expect(progressIsLive({ export: { status: "partial_ready" } })).toBe(true);
    expect(progressIsLive({ export: { status: "ready" } })).toBe(false);
    expect(progressIsLive({ export: { status: "failed" } })).toBe(false);
    expect(progressIsLive({ operation: { kind: "export", id: "e" }, state: "working" })).toBe(true);
    for (const state of ["completed", "partial", "failed", "cancelled"]) expect(progressIsLive({ operation: { kind: "export", id: "e" }, state })).toBe(false);
    expect(progressIsLive({ project: { projectId: "p" }, progress: { status: "processing" } })).toBe(true);
    expect(progressIsLive({ project: { projectId: "p" } })).toBe(false);
  });
  test("the original queued result cannot undo a finished card when the host replays it", () => {
    const finished = { operation: { kind: "export", id: "e" }, state: "completed", progress: 1 };
    const original = { export: { exportId: "e", status: "queued", progress: 0 }, operation: { kind: "export", id: "e" } };
    expect(isStaleProgressReplay(finished, original)).toBe(true);
    expect(isStaleProgressReplay({ export: { exportId: "e", status: "ready" } }, original)).toBe(true);
  });
  test("a newer state, and other work, are never treated as a replay", () => {
    const original = { export: { exportId: "e", status: "queued" }, operation: { kind: "export", id: "e" } };
    expect(isStaleProgressReplay(original, { operation: { kind: "export", id: "e" }, state: "completed" })).toBe(false);
    expect(isStaleProgressReplay({ operation: { kind: "export", id: "e" }, state: "working" }, original)).toBe(false);
    expect(isStaleProgressReplay({ operation: { kind: "export", id: "other" }, state: "completed" }, original)).toBe(false);
    expect(isStaleProgressReplay({}, original)).toBe(false);
  });
  test("a card reads at once, then quickly, then gently, and eventually stops", () => {
    expect(progressRefreshDelayMs(0)).toBe(0);
    expect(progressRefreshDelayMs(1)).toBe(3_000);
    expect(progressRefreshDelayMs(21)).toBe(15_000);
    expect(progressRefreshDelayMs(199)).toBe(15_000);
    expect(progressRefreshDelayMs(200)).toBeNull();
  });
});
