import { describe, expect, test } from "bun:test";
import { narriflowProgressRequest } from "./mcp-apps/v2/progress";
import { progressView } from "./mcp-apps/v2/views";

describe("App operation progress", () => {
  test("refreshes accepted work through its exact Operation Status", () => {
    expect(narriflowProgressRequest({ export: { exportId: "export" }, operation: { kind: "export", id: "export" } }, { workspaceId: "workspace", projectId: "project", clipId: "clip" }, {}))
      .toEqual({ name: "narriflow_get_operation", arguments: { workspaceId: "workspace", operation: { kind: "export", id: "export" } } });
    expect(narriflowProgressRequest({ operation: { kind: "generation", id: "run" }, projectId: "project" }, { workspaceId: "workspace" }, {}))
      .toEqual({ name: "narriflow_get_operation", arguments: { workspaceId: "workspace", operation: { kind: "generation", id: "run" } } });
  });
  test("uses safe operation metadata when Tasks replaces the initial result", () => {
    expect(narriflowProgressRequest({}, {}, { "narriflow/operation": { workspaceId: "workspace", projectId: "project", domainId: "job", domainKind: "intake" } }))
      .toEqual({ name: "narriflow_get_operation", arguments: { workspaceId: "workspace", operation: { kind: "intake", id: "job" } } });
    expect(() => narriflowProgressRequest({}, {}, { "narriflow/operation": { domainKind: "export", projectId: "project" } })).toThrow("Operation status is unavailable");
  });
  test("a Project snapshot refreshes itself and never stands in for accepted work", () => {
    expect(narriflowProgressRequest({ project: { workspaceId: "workspace", projectId: "project" } }, {}, {})).toEqual({ name: "narriflow_get_project", arguments: { workspaceId: "workspace", projectId: "project" } });
  });
  test("renders Operation Status with partial outcomes", () => {
    const view = progressView({ operation: { kind: "generation", id: "run" }, state: "partial", stage: "rendering", progress: 1,
      items: [{ kind: "clip", id: "a", state: "completed" }, { kind: "clip", id: "b", state: "failed" }] });
    expect(view.badge).toBe("Partial");
    expect(view.html).toContain("1 of 2 clips finished");
  });
});
