import { describe, expect, mock, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { ExpectedDomainFailureError } from "@narriflow/services";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { createInventoryApp } from "../../test-app";
import { createDeveloperRoutes, type DeveloperRouteDeps } from "./routes";

const WEB = "http://localhost:3000";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const KEY = "00000000-0000-4000-8000-000000000030";
const HOOK = "00000000-0000-4000-8000-000000000040";
const user = { id: "user-1", clerkId: "clerk-1", primaryEmail: "o@example.com", firstName: "Olu", lastName: null, imageUrl: null } as AppUser;

function context(role: WorkspaceActorContext["role"], pricingTier: WorkspaceActorContext["pricingTier"]): WorkspaceActorContext {
  return {
    userId: user.id,
    workspaceId: WORKSPACE,
    workspaceName: "Team",
    workspaceOwnerUserId: user.id,
    role,
    status: "active",
    pricingTier,
    isPersonal: false,
    workspaceSelectionChanged: false,
  };
}

function policy(options: { role?: WorkspaceActorContext["role"]; tier?: WorkspaceActorContext["pricingTier"]; rate?: (key: string) => boolean } = {}) {
  return createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) =>
      hint === WORKSPACE ? context(options.role ?? "owner", options.tier ?? "business") : null,
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "inaccessible" }) as never,
      rateLimit: async ({ key }) => {
        const allowed = options.rate?.(key) ?? true;
        return allowed
          ? { allowed: true, availability: "available", limit: 60, remaining: 59, resetSeconds: 60 }
          : { allowed: false, availability: "available", limit: 60, remaining: 0, resetSeconds: 60, retryAfterSeconds: 30 };
      },
      now: () => 1_000,
    } as never,
  });
}

const webhook = {
  webhookId: HOOK, urlHost: "hooks.example.com", types: ["operation.finished"], status: "active", disabledReason: null,
  disabledAt: null, lastDeliveredSeq: 0, consecutiveFailures: 0, lastAttemptAt: null, lastResponseStatus: null,
  lastDeliveredAt: null, createdAt: "2030-01-01T00:00:00.000Z",
};
const keyRow = {
  id: KEY, name: "n8n", prefix: "nf_abcdefgh", scopes: ["projects:read"],
  lastUsedAt: new Date("2030-02-01T00:00:00Z"), createdAt: new Date("2030-01-01T00:00:00Z"),
};
const alreadyIssued = () =>
  new ExpectedDomainFailureError({
    code: "credential_already_issued",
    kind: "conflict",
    message: "This API key was already created, and a key can't be shown a second time.",
    details: { credential: "api_key", keyId: KEY },
  });

function deps(over: Partial<DeveloperRouteDeps> = {}) {
  const base = {
    workspaceService: {
      listApiKeys: mock(async () => [keyRow]),
      revokeApiKey: mock(async () => undefined),
    },
    developerCommands: {
      createApiKey: mock(async (_actor: unknown, _input: unknown, mutation: { beforeAccept?: () => Promise<void> }) => {
        await mutation.beforeAccept?.();
        return { key: { id: KEY, name: "n8n", prefix: "nf_abcdefgh", scopes: ["projects:read"], createdAt: "2030-01-01T00:00:00.000Z" }, secret: "nf_one-time-secret" };
      }),
      rotateCallbackSigningSecret: mock(async (_actor: unknown, mutation: { beforeAccept?: () => Promise<void> }) => {
        await mutation.beforeAccept?.();
        return { createdAt: "2030-01-01T00:00:00.000Z", secret: "whsec_one-time" };
      }),
      createWebhook: mock(async (_actor: unknown, _input: unknown, mutation: { beforeAccept?: () => Promise<void> }) => {
        await mutation.beforeAccept?.();
        return { webhook, replayed: false };
      }),
      testWebhook: mock(async (_actor: unknown, _id: string, mutation: { beforeAccept?: () => Promise<void> }) => {
        await mutation.beforeAccept?.();
        return { result: { eventId: HOOK, delivered: true, status: 200, durationMs: 12 }, replayed: false };
      }),
    },
    callbackSigningSecrets: {
      status: mock(async () => ({ current: { createdAt: "2030-01-01T00:00:00.000Z" }, previousRetiresAt: null })),
    },
    webhookSubscriptions: {
      list: mock(async () => [webhook]),
      delete: mock(async (_actor: unknown, id: string) => ({ webhookId: id })),
      enable: mock(async () => webhook),
    },
    socialOAuthService: { listAccounts: mock(async () => []) },
    ...over,
  };
  return base as unknown as DeveloperRouteDeps & typeof base;
}

function app(routeDeps: DeveloperRouteDeps, options: Parameters<typeof policy>[0] = {}) {
  return createInventoryApp({
    policyRuntime: policy(options),
    domains: { developer: createDeveloperRoutes(routeDeps) },
  });
}

const headers = (extra: Record<string, string> = {}) => ({
  authorization: "Bearer good",
  "x-workspace-id": WORKSPACE,
  origin: WEB,
  "content-type": "application/json",
  ...extra,
});

const send = (routeApp: ReturnType<typeof app>, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  routeApp.request(`/api${path}`, { method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body) });

const keyed = { "idempotency-key": "intent-1" };

describe("admission", () => {
  test.each([
    ["GET", "/developer/settings", undefined],
    ["GET", "/workspace/api-keys", undefined],
    ["POST", "/workspace/api-keys", { name: "n8n" }],
    ["DELETE", `/workspace/api-keys/${KEY}`, undefined],
    ["GET", "/workspace/callback-signing-secret", undefined],
    ["POST", "/workspace/callback-signing-secret/rotate", undefined],
    ["GET", "/workspace/webhooks", undefined],
    ["POST", "/workspace/webhooks", { url: "https://hooks.example.com/x", types: ["operation.finished"] }],
    ["DELETE", `/workspace/webhooks/${HOOK}`, undefined],
    ["POST", `/workspace/webhooks/${HOOK}/enable`, undefined],
    ["POST", `/workspace/webhooks/${HOOK}/test`, undefined],
  ])("%s %s needs api.manage", async (method, path, body) => {
    const d = deps();
    const response = await send(app(d, { role: "viewer" }), method, path, body, keyed);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "capability_denied" });
    expect(d.workspaceService.listApiKeys).not.toHaveBeenCalled();
    expect(d.developerCommands.createApiKey).not.toHaveBeenCalled();
    expect(d.webhookSubscriptions.list).not.toHaveBeenCalled();
  });
});

describe("integrations overview", () => {
  test("a viewer reads the accounts and nothing private", async () => {
    const d = deps();
    const response = await send(app(d, { role: "viewer" }), "GET", "/integrations");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accounts: [], apiKeys: null, signing: null });
    expect(d.workspaceService.listApiKeys).not.toHaveBeenCalled();
    expect(d.callbackSigningSecrets.status).not.toHaveBeenCalled();
  });

  test("an owner also gets a key count and whether a signing secret exists", async () => {
    const response = await send(app(deps()), "GET", "/integrations");
    expect(await response.json()).toEqual({ accounts: [], apiKeys: { count: 1 }, signing: { configured: true } });
  });
});

describe("developer settings", () => {
  test("returns keys with ISO dates and no secret, signing status and webhooks together", async () => {
    const response = await send(app(deps()), "GET", "/developer/settings");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.apiAccess).toBe(true);
    expect(body.keys).toEqual([{ ...keyRow, lastUsedAt: "2030-02-01T00:00:00.000Z", createdAt: "2030-01-01T00:00:00.000Z" }]);
    expect(JSON.stringify(body)).not.toContain("hashedSecret");
    expect(body.signing.current.createdAt).toBe("2030-01-01T00:00:00.000Z");
    expect(body.webhooks).toHaveLength(1);
  });

  test("a plan without API access lists no webhooks and says so", async () => {
    const d = deps();
    const body = await (await send(app(d, { tier: "free" }), "GET", "/developer/settings")).json();
    expect(body.apiAccess).toBe(false);
    expect(body.webhooks).toEqual([]);
    expect(d.webhookSubscriptions.list).not.toHaveBeenCalled();
  });
});

describe("one-time credentials", () => {
  test("creating a key needs an Idempotency-Key and returns the secret in that response only", async () => {
    const d = deps();
    const routeApp = app(d);
    const missing = await send(routeApp, "POST", "/workspace/api-keys", { name: "n8n" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "idempotency_key_required" });
    expect(d.developerCommands.createApiKey).not.toHaveBeenCalled();

    const created = await send(routeApp, "POST", "/workspace/api-keys", { name: "n8n", scopes: ["projects:read"] }, keyed);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ key: { id: KEY, prefix: "nf_abcdefgh" }, secret: "nf_one-time-secret" });
    const call = d.developerCommands.createApiKey.mock.calls[0] as unknown as [{ actorUserId: string; workspaceId: string }, unknown, { clientIdempotencyKey: string }];
    expect(call[0]).toMatchObject({ actorUserId: "user-1", workspaceId: WORKSPACE });
    expect(call[2].clientIdempotencyKey).toBe("intent-1");
  });

  test("a replayed key creation answers credential_already_issued, with no secret", async () => {
    const d = deps({ developerCommands: { ...deps().developerCommands, createApiKey: mock(async () => { throw alreadyIssued(); }) } as never });
    const response = await send(app(d), "POST", "/workspace/api-keys", { name: "n8n" }, keyed);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ error: "credential_already_issued", details: { keyId: KEY } });
    expect(JSON.stringify(body)).not.toContain("nf_");
  });

  test("rotating the signing secret needs a key and returns the secret once", async () => {
    const d = deps();
    const routeApp = app(d);
    expect((await send(routeApp, "POST", "/workspace/callback-signing-secret/rotate")).status).toBe(400);
    const rotated = await send(routeApp, "POST", "/workspace/callback-signing-secret/rotate", undefined, keyed);
    expect(rotated.status).toBe(201);
    expect(await rotated.json()).toEqual({ createdAt: "2030-01-01T00:00:00.000Z", secret: "whsec_one-time" });
  });

  test("an exhausted limiter refuses a new key but a replay is answered first", async () => {
    const exhausted = { rate: () => false };
    const fresh = await send(app(deps(), exhausted), "POST", "/workspace/api-keys", { name: "n8n" }, keyed);
    expect(fresh.status).toBe(429);

    const replayDeps = deps({ developerCommands: { ...deps().developerCommands, createApiKey: mock(async () => { throw alreadyIssued(); }) } as never });
    const replay = await send(app(replayDeps, exhausted), "POST", "/workspace/api-keys", { name: "n8n" }, keyed);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: "credential_already_issued" });
  });

  test("validates the key body", async () => {
    const routeApp = app(deps());
    expect((await send(routeApp, "POST", "/workspace/api-keys", { name: "" }, keyed)).status).toBe(400);
    expect((await send(routeApp, "POST", "/workspace/api-keys", { name: "x", scopes: ["billing:write"] }, keyed)).status).toBe(400);
  });
});

describe("keys and webhooks", () => {
  test("revoking acts for the signed-in member in the selected Workspace", async () => {
    const d = deps();
    const response = await send(app(d), "DELETE", `/workspace/api-keys/${KEY}`);
    expect(await response.json()).toEqual({ ok: true });
    expect(d.workspaceService.revokeApiKey).toHaveBeenCalledWith("user-1", WORKSPACE, KEY);
    expect((await send(app(d), "DELETE", "/workspace/api-keys/not-a-uuid")).status).toBe(400);
  });

  test("webhook commands need the plan's API access", async () => {
    const d = deps();
    const routeApp = app(d, { tier: "free" });
    for (const [method, path] of [
      ["GET", "/workspace/webhooks"],
      ["DELETE", `/workspace/webhooks/${HOOK}`],
      ["POST", `/workspace/webhooks/${HOOK}/enable`],
      ["POST", `/workspace/webhooks/${HOOK}/test`],
    ] as const) {
      const response = await send(routeApp, method, path, undefined, keyed);
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({ error: "plan_feature_required" });
    }
    expect(d.webhookSubscriptions.delete).not.toHaveBeenCalled();
    expect(d.developerCommands.testWebhook).not.toHaveBeenCalled();
  });

  test("create is idempotent: a replay is 200 with the replay header", async () => {
    const d = deps();
    const body = { url: "https://hooks.example.com/x", types: ["operation.finished"] };
    expect((await send(app(d), "POST", "/workspace/webhooks", body)).status).toBe(400);
    const created = await send(app(d), "POST", "/workspace/webhooks", body, keyed);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ webhook, replayed: false });

    const replayDeps = deps({ developerCommands: { ...d.developerCommands, createWebhook: mock(async () => ({ webhook, replayed: true })) } as never });
    const replay = await send(app(replayDeps), "POST", "/workspace/webhooks", body, keyed);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
  });

  test("create validates the endpoint and event types", async () => {
    const routeApp = app(deps());
    expect((await send(routeApp, "POST", "/workspace/webhooks", { url: "not a url", types: ["operation.finished"] }, keyed)).status).toBe(400);
    expect((await send(routeApp, "POST", "/workspace/webhooks", { url: "https://hooks.example.com/x", types: [] }, keyed)).status).toBe(400);
  });

  test("delete, enable and test return their results", async () => {
    const routeApp = app(deps());
    expect(await (await send(routeApp, "DELETE", `/workspace/webhooks/${HOOK}`)).json()).toEqual({ webhookId: HOOK, deleted: true });
    expect(await (await send(routeApp, "POST", `/workspace/webhooks/${HOOK}/enable`)).json()).toEqual({ webhook });
  });

  test("a test needs a key, and a retry with the same key replays the recorded answer", async () => {
    const d = deps();
    const path = `/workspace/webhooks/${HOOK}/test`;
    expect((await send(app(d), "POST", path)).status).toBe(400);
    expect(d.developerCommands.testWebhook).not.toHaveBeenCalled();

    const sent = await send(app(d), "POST", path, undefined, keyed);
    expect(sent.status).toBe(200);
    expect(sent.headers.get("idempotent-replayed")).toBeNull();
    expect(await sent.json()).toEqual({ eventId: HOOK, delivered: true, status: 200, durationMs: 12 });
    expect(d.developerCommands.testWebhook).toHaveBeenCalledWith(expect.anything(), HOOK, expect.objectContaining({ clientIdempotencyKey: "intent-1" }));

    const replayDeps = deps({
      developerCommands: { ...d.developerCommands, testWebhook: mock(async () => ({ result: { eventId: HOOK, delivered: true, status: 200, durationMs: 12 }, replayed: true })) } as never,
    });
    const replay = await send(app(replayDeps), "POST", path, undefined, keyed);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toMatchObject({ eventId: HOOK });
  });
});
