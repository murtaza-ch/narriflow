import { describe, expect, test } from "bun:test";
import { createApiRuntime } from "../core/runtime";
import { sessionKey } from "../core/keys";
import { fakeFetch, jsonResponse, USER, WORKSPACE_A, WORKSPACE_B } from "../core/test-helpers";
import { acceptInviteMutation, selectWorkspaceMutation } from "./mutations";
import { inviteQuery, sessionBootstrapQuery } from "./queries";

function setup(...handlers: Parameters<typeof fakeFetch>) {
  const { fetch, calls } = fakeFetch(...handlers);
  const api = createApiRuntime({ baseUrl: "https://api.example.test", getToken: async () => "token", fetch });
  api.setIdentity(USER);
  return { api, calls };
}

const selection = (id: string) => ({
  workspace: { id, name: "Team", role: "owner", status: "restricted", pricingTier: "business", isPersonal: false, avatarUrl: null },
  capabilities: {},
});

describe("session bootstrap", () => {
  test("is identity-keyed and sends the saved hint without a Workspace header", async () => {
    const { api, calls } = setup(() => jsonResponse({ selection: { workspaceId: WORKSPACE_A } }));
    const options = sessionBootstrapQuery(api.transport, { userId: USER }, WORKSPACE_A);
    expect(options.queryKey).toEqual(sessionKey({ userId: USER }, "bootstrap") as unknown as typeof options.queryKey);
    await api.queryClient.fetchQuery(options);
    expect(calls[0]?.url).toBe(`https://api.example.test/api/session/bootstrap?workspaceId=${WORKSPACE_A}`);
    expect(calls[0]?.headers.get("x-workspace-id")).toBeNull();
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer token");
  });

  test("an invitation key carries a digest, never the token", () => {
    const { api } = setup(() => jsonResponse({}));
    const options = inviteQuery(api.transport, { userId: USER }, { token: "secret-token-value-123", digest: "a".repeat(64) });
    expect(JSON.stringify(options.queryKey)).not.toContain("secret-token");
  });
});

describe("workspace selection", () => {
  test("switching adopts the selection, drops the old Workspace's queries and works from a restricted one", async () => {
    const { api, calls } = setup(() => jsonResponse(selection(WORKSPACE_B)));
    api.selectWorkspace(WORKSPACE_A);
    api.queryClient.setQueryData(["nf", USER, WORKSPACE_A, "projects", "list"], [1]);
    const options = selectWorkspaceMutation(api, { userId: USER });
    const result = await options.mutationFn?.(WORKSPACE_B, undefined as never);
    expect(calls[0]?.url).toBe("https://api.example.test/api/session/workspace-selection");
    expect(calls[0]?.headers.get("x-workspace-id")).toBeNull();
    await options.onSuccess?.(result as never, WORKSPACE_B, undefined, undefined as never);
    expect(api.scope.snapshot().workspaceId).toBe(WORKSPACE_B);
    expect(api.queryClient.getQueryData(["nf", USER, WORKSPACE_A, "projects", "list"])).toBeUndefined();
  });

  test("accepting an invitation selects the joined Workspace and returns where to go", async () => {
    const { api, calls } = setup(() => jsonResponse({ ...selection(WORKSPACE_B), destination: "/home" }));
    const options = acceptInviteMutation(api, { userId: USER });
    const accepted = await options.mutationFn?.("t".repeat(24), undefined as never);
    expect(calls[0]?.url).toBe(`https://api.example.test/api/invites/${"t".repeat(24)}/accept`);
    expect(accepted).toMatchObject({ destination: "/home" });
    await options.onSuccess?.(accepted as never, "t".repeat(24), undefined, undefined as never);
    expect(api.scope.snapshot().workspaceId).toBe(WORKSPACE_B);
  });
});
