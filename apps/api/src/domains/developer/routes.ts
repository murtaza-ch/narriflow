import type {
  DeveloperCommands,
  callbackSigningSecrets,
  socialOAuthService,
  webhookSubscriptions,
  workspaceService,
} from "@narriflow/services";
import { hasFeature, requirePlanFeature } from "@narriflow/services";
import { workspaceAllowsCapability } from "@narriflow/validators";
import {
  createApiKeyRequestSchema,
  createWebhookRequestSchema,
  type ApiKeyIssued,
  type ApiKeySummary,
  type ApiKeysResult,
  type CallbackSigningSecretIssued,
  type CallbackSigningStatus,
  type DeveloperSettings,
  type IntegrationsOverview,
  type WebhookCreatedResult,
  type WebhookEnabledResult,
  type WebhookTestResult,
  type WebhooksResult,
} from "@narriflow/validators/api/developer";
import type { Context } from "hono";
import { createRouteApp, getActor, getRecordedRateLimit } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { getIdempotencyKey, requireIdempotencyKey } from "../../http/idempotency";
import { enforceRecordedRateLimit } from "../../http/limits";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { developerAdmission as access } from "./admission";

/** Services the developer routes call. `runtime.ts` supplies the production instances. */
export interface DeveloperRouteDeps {
  workspaceService: Pick<typeof workspaceService, "listApiKeys" | "revokeApiKey">;
  developerCommands: Pick<DeveloperCommands, "createApiKey" | "rotateCallbackSigningSecret" | "createWebhook" | "testWebhook">;
  callbackSigningSecrets: Pick<typeof callbackSigningSecrets, "status">;
  webhookSubscriptions: Pick<typeof webhookSubscriptions, "list" | "delete" | "enable">;
  socialOAuthService: Pick<typeof socialOAuthService, "listAccounts">;
}

type Keys = Awaited<ReturnType<DeveloperRouteDeps["workspaceService"]["listApiKeys"]>>;

function toKeySummaries(keys: Keys): ApiKeySummary[] {
  return keys.map((key) => ({
    ...key,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  }));
}

/**
 * Developer access and the Integrations overview. Keys and the signing secret are
 * issued exactly once, by receipt-backed commands: a replay answers
 * `credential_already_issued` and never mints another credential.
 */
export function createDeveloperRoutes(deps: DeveloperRouteDeps) {
  const { workspaceService, developerCommands, callbackSigningSecrets, webhookSubscriptions, socialOAuthService } =
    deps;

  const mutationFor = (c: Context<ApiEnv>) => ({
    clientIdempotencyKey: getIdempotencyKey(c),
    beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
  });

  /** Webhooks share REST's rule: the plan's API access, then the service's own refusals. */
  const requireApiPlan = (c: Context<ApiEnv>) => requirePlanFeature(getActor(c).pricingTier, "integrations.api");

  return createRouteApp(access)
    .get("/integrations", async (c) => {
      const actor = getActor(c);
      // The key and signing facts are api.manage data: nothing is read for anyone else.
      const canManageApi = workspaceAllowsCapability({ role: actor.role, status: actor.status }, "api.manage");
      const [accounts, keys, signing] = await Promise.all([
        socialOAuthService.listAccounts(actor),
        canManageApi ? workspaceService.listApiKeys(actor.actorUserId, actor.workspaceId) : null,
        canManageApi ? callbackSigningSecrets.status(actor.workspaceId) : null,
      ]);
      const body: IntegrationsOverview = {
        accounts,
        apiKeys: keys ? { count: keys.length } : null,
        signing: signing ? { configured: signing.current !== null } : null,
      };
      return c.json(body, 200);
    })

    .get("/developer/settings", async (c) => {
      const actor = getActor(c);
      const apiAccess = hasFeature(actor.pricingTier, "integrations.api");
      const [keys, signing, webhooks] = await Promise.all([
        workspaceService.listApiKeys(actor.actorUserId, actor.workspaceId),
        callbackSigningSecrets.status(actor.workspaceId),
        apiAccess ? webhookSubscriptions.list(actor) : [],
      ]);
      const body: DeveloperSettings = { apiAccess, keys: toKeySummaries(keys), signing, webhooks };
      return c.json(body, 200);
    })

    .get("/workspace/api-keys", async (c) => {
      const actor = getActor(c);
      const keys = await workspaceService.listApiKeys(actor.actorUserId, actor.workspaceId);
      const body: ApiKeysResult = { keys: toKeySummaries(keys) };
      return c.json(body, 200);
    })

    // One-time disclosure: the secret is in this response only. A replay is 409 credential_already_issued.
    .post(
      "/workspace/api-keys",
      requireIdempotencyKey(),
      validate("json", createApiKeyRequestSchema),
      async (c) => {
        const body: ApiKeyIssued = await developerCommands.createApiKey(
          getActor(c),
          c.req.valid("json"),
          mutationFor(c),
        );
        return c.json(body, 201);
      },
    )

    .delete("/workspace/api-keys/:keyId", uuidParams("keyId"), async (c) => {
      const actor = getActor(c);
      await workspaceService.revokeApiKey(actor.actorUserId, actor.workspaceId, c.req.valid("param").keyId);
      return c.json({ ok: true as const }, 200);
    })

    .get("/workspace/callback-signing-secret", async (c) => {
      const body: CallbackSigningStatus = await callbackSigningSecrets.status(getActor(c).workspaceId);
      return c.json(body, 200);
    })

    .post("/workspace/callback-signing-secret/rotate", requireIdempotencyKey(), async (c) => {
      const body: CallbackSigningSecretIssued = await developerCommands.rotateCallbackSigningSecret(
        getActor(c),
        mutationFor(c),
      );
      return c.json(body, 201);
    })

    .get("/workspace/webhooks", async (c) => {
      requireApiPlan(c);
      const body: WebhooksResult = { webhooks: await webhookSubscriptions.list(getActor(c)) };
      return c.json(body, 200);
    })

    .post(
      "/workspace/webhooks",
      requireIdempotencyKey(),
      validate("json", createWebhookRequestSchema),
      async (c) => {
        const created = await developerCommands.createWebhook(getActor(c), c.req.valid("json"), mutationFor(c));
        if (created.replayed) c.header("Idempotent-Replayed", "true");
        const body: WebhookCreatedResult = created;
        return c.json(body, created.replayed ? 200 : 201);
      },
    )

    .delete("/workspace/webhooks/:webhookId", uuidParams("webhookId"), async (c) => {
      requireApiPlan(c);
      const result = await webhookSubscriptions.delete(getActor(c), c.req.valid("param").webhookId);
      return c.json({ webhookId: result.webhookId, deleted: true as const }, 200);
    })

    .post("/workspace/webhooks/:webhookId/enable", uuidParams("webhookId"), async (c) => {
      requireApiPlan(c);
      const webhook = await webhookSubscriptions.enable(getActor(c), c.req.valid("param").webhookId);
      const body: WebhookEnabledResult = { webhook };
      return c.json(body, 200);
    })

    // Sends one signed `webhook.test` event now. The endpoint's answer is recorded under the caller's key, so a
    // retry after a lost response replays it; the service still allows one new test per webhook every few seconds.
    .post("/workspace/webhooks/:webhookId/test", requireIdempotencyKey(), uuidParams("webhookId"), async (c) => {
      requireApiPlan(c);
      const tested = await developerCommands.testWebhook(getActor(c), c.req.valid("param").webhookId, mutationFor(c));
      if (tested.replayed) c.header("Idempotent-Replayed", "true");
      const body: WebhookTestResult = tested.result;
      return c.json(body, 200);
    });
}

export type DeveloperRoutes = ReturnType<typeof createDeveloperRoutes>;
