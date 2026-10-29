import { describe, expect, test } from "bun:test";
import { MutationObserver } from "@tanstack/query-core";
import { ApiError } from "../core/error";
import { scopedKey } from "../core/keys";
import { createApiRuntime } from "../core/runtime";
import { fakeFetch, jsonResponse, USER, WORKSPACE_A } from "../core/test-helpers";
import {
  createApiKeyMutation,
  createWebhookMutation,
  isCredentialAlreadyIssued,
  rotateCallbackSigningSecretMutation,
  testWebhookMutation,
} from "./mutations";
import { developerSettingsQuery, integrationsOverviewQuery } from "./queries";

const scope = { userId: USER, workspaceId: WORKSPACE_A };
const headers = { "X-Workspace-Id": WORKSPACE_A };

function setup(...handlers: Parameters<typeof fakeFetch>) {
  const { fetch, calls } = fakeFetch(...handlers);
  const api = createApiRuntime({ baseUrl: "https://api.example.test", getToken: async () => "token", fetch });
  api.setIdentity(USER);
  api.selectWorkspace(WORKSPACE_A);
  return { api, calls };
}

const issued = { key: { id: "k1", name: "n8n", prefix: "nf_abcdefgh", scopes: ["projects:read"], createdAt: "2030-01-01T00:00:00.000Z" }, secret: "nf_one-time" };
const alreadyIssued = () =>
  jsonResponse({ error: "credential_already_issued", message: "exists", requestId: "r1", details: { keyId: "k1" } }, { status: 409, headers });

describe("developer reads", () => {
  test("settings are Workspace-scoped and sent with the explicit selection", async () => {
    const { api, calls } = setup(() => jsonResponse({ apiAccess: true, keys: [], signing: { current: null, previousRetiresAt: null }, webhooks: [] }, { headers }));
    const options = developerSettingsQuery(api.transport, scope);
    expect(options.queryKey).toEqual(scopedKey(scope, "developer", "settings") as never);
    await api.queryClient.fetchQuery(options);
    expect(calls[0]?.url).toBe("https://api.example.test/api/developer/settings");
    expect(calls[0]?.headers.get("x-workspace-id")).toBe(WORKSPACE_A);
  });

  test("the overview seeds the publishing accounts read", async () => {
    const accounts = [{ id: "a1" }];
    const { api, calls } = setup(() => jsonResponse({ accounts, apiKeys: null, signing: null }, { headers }));
    await api.queryClient.fetchQuery(integrationsOverviewQuery(api.transport, scope));
    expect(calls[0]?.url).toBe("https://api.example.test/api/integrations");
    expect(api.queryClient.getQueryData(scopedKey(scope, "publishing", "accounts") as never)).toEqual({ accounts });
  });
});

describe("one-time credentials", () => {
  test("a key is never retried automatically and its result is dropped once unobserved", () => {
    const { api } = setup();
    for (const options of [createApiKeyMutation(api, scope, () => undefined), rotateCallbackSigningSecretMutation(api, scope, () => undefined)]) {
      expect(options.retry).toBe(false);
      expect(options.gcTime).toBe(0);
    }
  });

  test("a manual retry reuses the intent's key; a changed request or a finished intent takes a new one", async () => {
    const { api, calls } = setup(
      () => new Response("down", { status: 503 }),
      () => jsonResponse(issued, { status: 201, headers }),
      () => jsonResponse(issued, { status: 201, headers }),
      () => jsonResponse(issued, { status: 201, headers }),
    );
    const options = createApiKeyMutation(api, scope, () => undefined);
    const input = { name: "n8n", scopes: ["projects:read" as const] };
    await expect(options.mutationFn?.(input, undefined as never)).rejects.toThrow();
    await options.mutationFn?.(input, undefined as never);
    const first = calls[0]?.headers.get("idempotency-key");
    expect(first).toBeTruthy();
    expect(calls[1]?.headers.get("idempotency-key")).toBe(first);

    await options.onSuccess?.(issued as never, input, undefined, undefined as never);
    await options.mutationFn?.(input, undefined as never);
    expect(calls[2]?.headers.get("idempotency-key")).not.toBe(first);

    await options.mutationFn?.({ ...input, name: "other" }, undefined as never);
    expect(calls[3]?.headers.get("idempotency-key")).not.toBe(calls[2]?.headers.get("idempotency-key"));
  });

  test("credential_already_issued ends the intent, so the next attempt is a new issuance", async () => {
    const { api, calls } = setup(alreadyIssued, () => jsonResponse(issued, { status: 201, headers }));
    const options = createApiKeyMutation(api, scope, () => undefined);
    const input = { name: "n8n" };
    const failure = await options.mutationFn?.(input, undefined as never).catch((error: unknown) => error);
    expect(isCredentialAlreadyIssued(failure)).toBe(true);
    expect(failure).toBeInstanceOf(ApiError);
    await options.onError?.(failure as never, input, undefined, undefined as never);
    await options.mutationFn?.(input, undefined as never);
    expect(calls[1]?.headers.get("idempotency-key")).not.toBe(calls[0]?.headers.get("idempotency-key"));
  });

  test("the secret never reaches a query or the query cache", async () => {
    const { api } = setup(() => jsonResponse(issued, { status: 201, headers }));
    const options = createApiKeyMutation(api, scope, () => undefined);
    const result = await options.mutationFn?.({ name: "n8n" }, undefined as never);
    await options.onSuccess?.(result as never, { name: "n8n" }, undefined, undefined as never);
    expect(JSON.stringify(api.queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain("one-time");
  });

  test("a real mutation hands the secret to the callback and no cache update ever holds it", async () => {
    for (const [name, build, reply] of [
      ["key", (api: ReturnType<typeof setup>["api"], sink: (secret: string) => void) => createApiKeyMutation(api, scope, sink), issued],
      [
        "rotation",
        (api: ReturnType<typeof setup>["api"], sink: (secret: string) => void) => rotateCallbackSigningSecretMutation(api, scope, sink),
        { createdAt: "2030-01-01T00:00:00.000Z", secret: "nf_one-time" },
      ],
    ] as const) {
      const { api } = setup(() => jsonResponse(reply, { status: 201, headers }));
      const seen: string[] = [];
      const snapshot = () =>
        seen.push(
          JSON.stringify([
            api.queryClient.getMutationCache().getAll().map((mutation) => [mutation.state.data, mutation.state.variables, mutation.state.error]),
            api.queryClient.getQueryCache().getAll().map((query) => [query.queryKey, query.state.data]),
          ]),
        );
      const unsubscribe = api.queryClient.getMutationCache().subscribe(snapshot);
      const received: string[] = [];
      const observer = new MutationObserver(api.queryClient, build(api, (secret) => received.push(secret)) as never);
      const result = await observer.mutate({ name: "n8n" } as never);
      snapshot();
      unsubscribe();
      expect(received).toEqual(["nf_one-time"]);
      expect(seen.length).toBeGreaterThan(2);
      expect(seen.join("")).not.toContain("one-time");
      expect(JSON.stringify(result)).not.toContain("one-time");
      expect(name).toBeTruthy();
    }
  });

  test("rotation sends a key and treats a replay like a key creation", async () => {
    const { api, calls } = setup(alreadyIssued, () => jsonResponse({ createdAt: "2030-01-01T00:00:00.000Z", secret: "whsec_x" }, { status: 201, headers }));
    const options = rotateCallbackSigningSecretMutation(api, scope, () => undefined);
    const failure = await options.mutationFn?.(undefined as never, undefined as never).catch((error: unknown) => error);
    expect(isCredentialAlreadyIssued(failure)).toBe(true);
    expect(calls[0]?.url).toBe("https://api.example.test/api/workspace/callback-signing-secret/rotate");
    expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
  });
});

describe("webhooks", () => {
  test("registering keeps one key per request and sends the body", async () => {
    const { api, calls } = setup(() => new Response("down", { status: 503 }), () => jsonResponse({ webhook: {}, replayed: true }, { status: 200, headers }));
    const options = createWebhookMutation(api, scope);
    const input = { url: "https://hooks.example.com/x", types: ["operation.finished" as const] };
    await expect(options.mutationFn?.(input, undefined as never)).rejects.toThrow();
    await options.mutationFn?.(input, undefined as never);
    expect(calls[1]?.headers.get("idempotency-key")).toBe(calls[0]?.headers.get("idempotency-key"));
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(input);
  });

  test("a test posts to the webhook's own path; a retry keeps its key and a finished test takes a new one", async () => {
    const id = "00000000-0000-4000-8000-000000000040";
    const ok = () => jsonResponse({ eventId: "e", delivered: true, status: 200, durationMs: 4 }, { headers });
    const { api, calls } = setup(() => new Response("down", { status: 503 }), ok, ok);
    const options = testWebhookMutation(api, scope);
    await expect(options.mutationFn?.(id, undefined as never)).rejects.toThrow();
    const result = await options.mutationFn?.(id, undefined as never);
    expect(result).toMatchObject({ delivered: true });
    expect(calls[0]?.url).toBe(`https://api.example.test/api/workspace/webhooks/${id}/test`);
    expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
    expect(calls[1]?.headers.get("idempotency-key")).toBe(calls[0]?.headers.get("idempotency-key"));
    await options.onSuccess?.(result as never, id, undefined, undefined as never);
    await options.mutationFn?.(id, undefined as never);
    expect(calls[2]?.headers.get("idempotency-key")).not.toBe(calls[0]?.headers.get("idempotency-key"));
  });
});
