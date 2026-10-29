import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import type { ApiError } from "../core/error";
import { isApiErrorCode } from "../core/error";
import { createApiRuntime } from "../core/runtime";
import { scopedKey, sessionKey } from "../core/keys";
import { errorResponse, fakeFetch, jsonResponse, USER, WORKSPACE_A } from "../core/test-helpers";
import { inviteMemberMutation, replaceCensorWordsMutation, updateWorkspaceMutation } from "./mutations";
import { workspaceBootstrapQuery } from "./queries";

const scope = { userId: USER, workspaceId: WORKSPACE_A };

function setup(...handlers: Parameters<typeof fakeFetch>) {
  const { fetch, calls } = fakeFetch(...handlers);
  const api = createApiRuntime({ baseUrl: "https://api.example.test", getToken: async () => "token", fetch });
  api.setIdentity(USER);
  api.selectWorkspace(WORKSPACE_A);
  return { api, calls };
}

const usage = { tier: "pro", usedCredits: 1, reservedCredits: 0, limitCredits: 10, remainingCredits: 9, periodStart: "2030-01-01T00:00:00.000Z", renewsAt: "2030-02-01T00:00:00.000Z", inFlight: 0, inFlightLimit: 2, maxUploadSeconds: 60 };
const issued = { invite: { id: "i1", email: "a@example.com", role: "editor", expiresAt: "2030-01-01T00:00:00.000Z" }, inviteUrl: "https://web/invite/x", emailSent: true };

describe("workspace queries", () => {
  test("bootstrap is Workspace-scoped, sends the explicit selection and seeds the usage query", async () => {
    const { api, calls } = setup(() => jsonResponse({ usage, workspace: {}, memberships: [], capabilities: {}, user: {} }, { headers: { "X-Workspace-Id": WORKSPACE_A } }));
    const options = workspaceBootstrapQuery(api.transport, scope);
    expect(options.queryKey).toEqual(scopedKey(scope, "workspace", "bootstrap") as unknown as typeof options.queryKey);
    await api.queryClient.fetchQuery(options);
    expect(calls[0]?.url).toBe("https://api.example.test/api/workspace/bootstrap");
    expect(calls[0]?.headers.get("x-workspace-id")).toBe(WORKSPACE_A);
    expect(calls[0]?.init.credentials).toBe("omit");
    expect(api.queryClient.getQueryData(scopedKey(scope, "workspace", "usage") as never)).toEqual(usage);
  });
});

describe("workspace mutations", () => {
  test("an invite keeps one idempotency key across a retry and takes a new one for new input", async () => {
    const { api, calls } = setup(
      () => new Response("down", { status: 503 }),
      () => jsonResponse(issued, { status: 201, headers: { "X-Workspace-Id": WORKSPACE_A } }),
      () => jsonResponse(issued, { status: 201, headers: { "X-Workspace-Id": WORKSPACE_A } }),
    );
    const options = inviteMemberMutation(api, scope);
    const input = { email: "a@example.com", role: "editor" as const };
    await expect(options.mutationFn?.(input, undefined as never)).rejects.toThrow();
    await options.mutationFn?.(input, undefined as never);
    const [first, retry] = calls.map((call) => call.headers.get("idempotency-key"));
    expect(first).toBeTruthy();
    expect(retry).toBe(first);
    expect(calls[1]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(input);

    await options.onSuccess?.(issued as never, input, undefined, undefined as never);
    await options.mutationFn?.({ ...input, email: "b@example.com" }, undefined as never);
    expect(calls[2]?.headers.get("idempotency-key")).not.toBe(first);
  });

  test("a lost invite response is credential_already_issued: the intent ends and the list refreshes for Resend", async () => {
    const { api, calls } = setup(
      () => errorResponse(409, "credential_already_issued", { details: { credential: "workspace_invite", inviteId: "i1", recovery: "resend_invite" } }),
      () => jsonResponse(issued, { status: 201, headers: { "X-Workspace-Id": WORKSPACE_A } }),
    );
    api.queryClient.setQueryData(scopedKey(scope, "workspace", "members") as never, { members: [], invites: [] });
    const options = inviteMemberMutation(api, scope);
    const input = { email: "a@example.com", role: "editor" as const };
    const error = await options.mutationFn?.(input, undefined as never).catch((caught: unknown) => caught);
    expect(isApiErrorCode(error, "credential_already_issued")).toBe(true);
    expect((error as ApiError).details).toMatchObject({ inviteId: "i1", recovery: "resend_invite" });
    await options.onError?.(error as never, input, undefined, undefined as never);
    expect(api.queryClient.getQueryState(scopedKey(scope, "workspace", "members") as never)?.isInvalidated).toBe(true);
    // The next invite is a new intent, not the same key that already issued.
    await options.mutationFn?.(input, undefined as never);
    expect(calls[1]?.headers.get("idempotency-key")).not.toBe(calls[0]?.headers.get("idempotency-key"));
  });

  test("saved profile and censor words refresh the cached reads of the same Workspace only", async () => {
    const { api } = setup(
      () => jsonResponse({ id: WORKSPACE_A, name: "N", timezone: "UTC" }, { headers: { "X-Workspace-Id": WORKSPACE_A } }),
      () => jsonResponse({ words: ["x"], customized: true }, { headers: { "X-Workspace-Id": WORKSPACE_A } }),
    );
    const queryClient: QueryClient = api.queryClient;
    const other = { userId: USER, workspaceId: "33333333-3333-4333-8333-333333333333" };
    queryClient.setQueryData(scopedKey(scope, "workspace", "profile") as never, { stale: true });
    queryClient.setQueryData(scopedKey(other, "workspace", "profile") as never, { stale: true });
    queryClient.setQueryData(sessionKey({ userId: USER }, "bootstrap") as never, { stale: true });

    const update = updateWorkspaceMutation(api, scope);
    await update.mutationFn?.({ name: "N", timezone: "UTC" }, undefined as never);
    await update.onSuccess?.({} as never, { name: "N", timezone: "UTC" }, undefined, undefined as never);
    expect(queryClient.getQueryState(scopedKey(scope, "workspace", "profile") as never)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(sessionKey({ userId: USER }, "bootstrap") as never)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(scopedKey(other, "workspace", "profile") as never)?.isInvalidated).toBe(false);

    const replace = replaceCensorWordsMutation(api, scope);
    const saved = await replace.mutationFn?.({ words: ["x"] }, undefined as never);
    await replace.onSuccess?.(saved as never, { words: ["x"] }, undefined, undefined as never);
    expect(queryClient.getQueryData(scopedKey(scope, "workspace", "censor-words") as never)).toEqual({ words: ["x"], customized: true });
  });
});
