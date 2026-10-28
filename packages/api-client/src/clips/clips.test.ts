import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { fakeFetch, jsonResponse, WORKSPACE_A, USER } from "../core/test-helpers";
import { createClipsClient } from "./index";
import { clipCommands, invalidateAfterClipChange } from "./mutations";
import { clipQueries } from "./queries";

const PROJECT = "40000000-0000-4000-8000-000000000001";
const CLIP = "40000000-0000-4000-8000-000000000002";

function clientWith(...handlers: Parameters<typeof fakeFetch>) {
  const recorded = fakeFetch(...handlers);
  const client = createClipsClient({
    baseUrl: "https://api.example.test",
    fetch: (input, init) => recorded.fetch(input as string, init),
  });
  return { client, calls: recorded.calls };
}

describe("clips client", () => {
  test("a duplicate sends the intent's Idempotency-Key and no body", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ id: "copy" }, { status: 201 }));
    expect(await clipCommands.duplicate(client, PROJECT, CLIP, "intent-1")).toEqual({ id: "copy" });
    expect(calls[0]?.url).toBe(`https://api.example.test/api/projects/${PROJECT}/clips/${CLIP}/duplicate`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("intent-1");
  });

  test("a campaign command carries the key and the explicit retry-of identity", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ operationId: "op" }));
    await clipCommands.applyStyle(
      client,
      PROJECT,
      { templateId: CLIP, templateFingerprint: "a".repeat(64), clips: [{ clipId: CLIP, expectedEditorRevision: 1 }] },
      "intent-2",
      "50000000-0000-4000-8000-000000000001",
    );
    expect(calls[0]?.url).toContain("/campaign-operations/apply-style");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("intent-2");
    expect(calls[0]?.headers.get("campaign-retry-of")).toBe("50000000-0000-4000-8000-000000000001");
  });

  test("peaks resolve to null on 204 and queries are keyed by identity and Workspace", async () => {
    const { client } = clientWith(() => new Response(null, { status: 204 }));
    const scope = { userId: USER, workspaceId: WORKSPACE_A };
    const options = clipQueries.peaks(client, scope, PROJECT, CLIP);
    expect(options.queryKey.slice(0, 4)).toEqual(["nf", USER, WORKSPACE_A, "clips"]);
    const controller = new AbortController();
    expect(await options.queryFn?.({ signal: controller.signal } as never)).toBeNull();
  });

  test("a clip change invalidates only its own Workspace's clip reads", async () => {
    const queryClient = new QueryClient();
    const scope = { userId: USER, workspaceId: WORKSPACE_A };
    const other = { userId: USER, workspaceId: "22222222-2222-4222-8222-222222222222" };
    const { client } = clientWith();
    for (const s of [scope, other]) {
      queryClient.setQueryData(clipQueries.list(client, s, PROJECT).queryKey, { clips: [] });
    }
    await invalidateAfterClipChange(queryClient, scope, PROJECT);
    expect(queryClient.getQueryState(clipQueries.list(client, scope, PROJECT).queryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(clipQueries.list(client, other, PROJECT).queryKey)?.isInvalidated).toBe(false);
  });
});
