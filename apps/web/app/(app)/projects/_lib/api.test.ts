import { describe, expect, mock, test } from "bun:test";
import { createApiRuntime } from "@narriflow/api-client/core";
import { createProjectsClient, projectQueries } from "@narriflow/api-client/projects";

mock.module("@/app/_components/api-provider", () => ({ useApiRuntime: () => null, useWorkspaceScope: () => null }));
const { explorerQueryOptions } = await import("./api");

const scope = { userId: "user_1", workspaceId: "ws_1" };
const page = { items: [{ id: "p1" }], nextCursor: null };

function setup() {
  let requests = 0;
  const runtime = createApiRuntime({
    baseUrl: "https://api.test",
    getToken: async () => "token",
    fetch: (async () => {
      requests += 1;
      return Response.json(
        { page, folders: [], activeFolder: null, access: {} },
        { headers: { "X-Workspace-Id": "ws_1" } },
      );
    }) as unknown as typeof fetch,
  });
  runtime.setIdentity("user_1");
  runtime.selectWorkspace("ws_1");
  const projects = createProjectsClient(runtime.transport.scoped(scope));
  return { runtime, projects, requests: () => requests };
}

describe("explorer query", () => {
  test("a prefetched explorer seeds page one of the paged list, as the mounted screen does", async () => {
    const { runtime, projects, requests } = setup();
    const { queryClient } = runtime;
    await queryClient.prefetchQuery(explorerQueryOptions(queryClient, { projects, scope }, { q: "x" }));
    const listKey = projectQueries.list(projects, scope, { q: "x" }).queryKey;
    expect(requests()).toBe(1);
    expect(queryClient.getQueryData(listKey)).toEqual({ pages: [page], pageParams: [null] });
  });

  test("a list already loaded further is left alone", async () => {
    const { runtime, projects } = setup();
    const { queryClient } = runtime;
    const listKey = projectQueries.list(projects, scope).queryKey;
    const loaded = { pages: [page, { items: [], nextCursor: null }], pageParams: [null, "c1"] };
    queryClient.setQueryData(listKey, loaded);
    await queryClient.prefetchQuery(explorerQueryOptions(queryClient, { projects, scope }));
    expect(queryClient.getQueryData(listKey)).toBe(loaded);
  });
});
