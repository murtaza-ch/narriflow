import { describe, expect, test } from "bun:test";
import { narriflowProgressRequest } from "./mcp-apps/v1/progress";

describe("App operation progress", () => {
  test("refreshes an exact export rather than the project's generation", () => {
    expect(narriflowProgressRequest({ export: { exportId: "export", projectId: "project", clipId: "clip" } }, { workspaceId: "workspace", projectId: "project", clipId: "clip" }, {}))
      .toEqual({ name: "narriflow_get_clip_export", arguments: { workspaceId: "workspace", projectId: "project", clipId: "clip", exportId: "export" } });
  });
  test("uses safe operation metadata when Tasks replaces the initial result", () => {
    expect(narriflowProgressRequest({}, {}, { "narriflow/operation": { workspaceId: "workspace", projectId: "project", clipId: "clip", domainId: "export", domainKind: "export" } }))
      .toEqual({ name: "narriflow_get_clip_export", arguments: { workspaceId: "workspace", projectId: "project", clipId: "clip", exportId: "export" } });
    expect(narriflowProgressRequest({}, {}, { "narriflow/operation": { workspaceId: "workspace", projectId: "project", domainId: "ingest", domainKind: "ingest" } }))
      .toEqual({ name: "narriflow_get_project", arguments: { workspaceId: "workspace", projectId: "project" } });
  });
  test("refreshes project facts and refuses incomplete export identity", () => {
    expect(narriflowProgressRequest({ project: { workspaceId: "workspace", projectId: "project" } }, {}, {})).toEqual({ name: "narriflow_get_project", arguments: { workspaceId: "workspace", projectId: "project" } });
    expect(() => narriflowProgressRequest({}, {}, { "narriflow/operation": { domainKind: "export", projectId: "project" } })).toThrow("Export status is unavailable");
  });
});
