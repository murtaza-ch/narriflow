import { describe, expect, test } from "bun:test";
import { createApiRuntime } from "../core/runtime";
import { fakeFetch, jsonResponse, USER, WORKSPACE_A } from "../core/test-helpers";
import { studioQueries } from "../studio";
import { publishingKeys, publishingQueries } from "./queries";

const scope = { userId: USER, workspaceId: WORKSPACE_A };

function setup() {
  const { fetch, calls } = fakeFetch(() => jsonResponse({}, { headers: { "X-Workspace-Id": WORKSPACE_A } }));
  const api = createApiRuntime({ baseUrl: "https://api.example.test", getToken: async () => "token", fetch });
  api.setIdentity(USER);
  api.selectWorkspace(WORKSPACE_A);
  return { api, calls };
}

/** The domain exports its own query factories and every request carries the query's AbortSignal (Sol B08). */
describe("domain query factories pass cancellation", () => {
  test("publishing queries are keyed by publishingKeys and abort with the query", async () => {
    const { api, calls } = setup();
    const controller = new AbortController();
    const options = publishingQueries.queue(api, scope);
    expect(options.queryKey).toEqual(publishingKeys.queue(scope) as never);
    const run = options.queryFn as (context: unknown) => Promise<unknown>;
    await run({ signal: controller.signal });
    expect(calls[0]?.url).toBe("https://api.example.test/api/publishing/queue");
    controller.abort();
    await expect(run({ signal: controller.signal })).rejects.toBeDefined();
  });

  test("studio reads are keyed under the studio domain and abort with the query", async () => {
    const { api, calls } = setup();
    const controller = new AbortController();
    const target = { projectId: "p1", clipId: "c1" };
    const options = studioQueries(api.transport, scope).previewSource(target);
    expect(options.queryKey).toEqual(["nf", USER, WORKSPACE_A, "studio", "preview-source", target] as never);
    const run = options.queryFn as (context: unknown) => Promise<unknown>;
    await run({ signal: controller.signal });
    expect(calls[0]?.url).toContain("/api/projects/p1/clips/c1/preview-source");
    controller.abort();
    await expect(run({ signal: controller.signal })).rejects.toBeDefined();
  });

  test("the Studio bootstrap is never refetched in the background", () => {
    const { api } = setup();
    const options = studioQueries(api.transport, scope).bootstrap({ projectId: "p1", clipId: "c1" });
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.gcTime).toBe(0);
  });
});
