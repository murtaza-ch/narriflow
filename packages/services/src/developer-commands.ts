import type { Prisma } from "@prisma/client";
import type { WorkspaceEventType, WebhookView } from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import type { IntegrationMutation } from "./operation-receipt";
import type { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { requirePlanFeature } from "./plan-features";
import { canonicalWebhookTypes, type WebhookSubscriptions } from "./webhook-subscription";
import { normalizeWorkspaceApiKeyInput, type WorkspaceService } from "./workspace.service";
import { DEVELOPER_RECEIPT_COMMANDS } from "./developer-receipt-commands";

/** Transport facts the developer commands need: the caller's key and the new-mutation limiter. */
export type DeveloperMutation = Pick<IntegrationMutation, "clientIdempotencyKey" | "beforeAccept">;

export interface DeveloperCommandDependencies {
  receipts: () => ReturnType<typeof getOperationReceiptExecutor>;
  workspaces: Pick<WorkspaceService, "requireActor" | "issueApiKey">;
  signingSecrets: {
    issue(tx: Prisma.TransactionClient, workspaceId: string): Promise<{ id: string; secret: string; createdAt: string }>;
  };
  webhooks: Pick<WebhookSubscriptions, "prepareCreate" | "insert" | "explainInsertFailure">;
  /** The SSRF guard for a webhook URL: HTTPS, public host, port 443. Resolves DNS. */
  assertCallbackUrl: (raw: string) => Promise<URL>;
}

/** What a receipt may keep of a key: no part of the secret except the display prefix already stored in the key table. */
export interface ApiKeyFacts {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
}

export interface ApiKeyIssued {
  key: ApiKeyFacts;
  /** Shown once, to the request that created the key. */
  secret: string;
}

export interface SigningSecretFacts {
  id: string;
  createdAt: string;
}

export interface SigningSecretIssued {
  createdAt: string;
  /** Shown once, to the request that rotated the secret. */
  secret: string;
}

export interface WebhookCreated {
  webhook: WebhookView;
  replayed: boolean;
}

/**
 * A replay of a command whose result is a one-time credential. The credential
 * is not in the receipt (nothing is stored in plaintext) and a replay never
 * issues another one, so the caller is told what exists and how to recover.
 */
export class CredentialAlreadyIssuedError extends ExpectedDomainFailureError<"credential_already_issued"> {
  constructor(message: string, details: Record<string, string>) {
    super({ code: "credential_already_issued", kind: "conflict", message, details });
    this.name = "CredentialAlreadyIssuedError";
  }
}

/**
 * Receipt-backed retryable commands of the developer domain. Only names
 * registered in `DEVELOPER_RECEIPT_COMMANDS` may be recorded.
 *
 * Creating an API key and rotating the callback signing secret hand out a
 * credential exactly once. Each commits its write and a credential-neutral
 * receipt in one transaction; the plaintext is held in memory by the accepting
 * request alone. A replay (a lost response, a double click, a retry) finds the
 * receipt, issues nothing, and answers `credential_already_issued`.
 */
export function createDeveloperCommands(deps: DeveloperCommandDependencies) {
  const { receipts, workspaces, signingSecrets, webhooks, assertCallbackUrl } = deps;

  /** The Workspace's API access, read where the write happens so a plan or role change after admission refuses it. */
  async function requireApiAccess(actor: ActorScope) {
    const current = await workspaces.requireActor(actor.actorUserId, actor.workspaceId, "api.manage");
    requirePlanFeature(current.pricingTier, "integrations.api");
    return current;
  }

  return {
    receiptCommands: DEVELOPER_RECEIPT_COMMANDS,

    /** Creates an API key. Throws `credential_already_issued` when this key was already created. */
    async createApiKey(
      actor: ActorScope,
      input: { name: string; scopes?: string[] },
      mutation: DeveloperMutation,
    ): Promise<ApiKeyIssued> {
      let issuedSecret: string | null = null;
      const accepted = await receipts().execute<ApiKeyFacts>({
        identity: {
          workspaceId: actor.workspaceId,
          actorUserId: actor.actorUserId,
          command: "create_api_key",
          clientIdempotencyKey: mutation.clientIdempotencyKey,
        },
        input: { name: input.name.trim(), scopes: input.scopes ? [...new Set(input.scopes)].sort() : null },
        authorize: async () => {
          await requireApiAccess(actor);
        },
        beforeAccept: mutation.beforeAccept,
        mutate: async (tx: Prisma.TransactionClient) => {
          const current = await requireApiAccess(actor);
          const normalized = normalizeWorkspaceApiKeyInput(current.pricingTier, input);
          const { secret, ...key } = await workspaces.issueApiKey(tx, actor.actorUserId, actor.workspaceId, normalized);
          issuedSecret = secret;
          return {
            resourceType: "api_key",
            resourceId: key.id,
            value: { ...key, createdAt: key.createdAt.toISOString() },
          };
        },
      });
      if (accepted.replayed || issuedSecret === null) {
        throw new CredentialAlreadyIssuedError(
          "This API key was already created, and a key can't be shown a second time. Revoke it and create a new one.",
          { credential: "api_key", keyId: accepted.value.id, name: accepted.value.name },
        );
      }
      return { key: accepted.value, secret: issuedSecret };
    },

    /** Creates or rotates the signing secret. Throws `credential_already_issued` when this rotation already happened. */
    async rotateCallbackSigningSecret(actor: ActorScope, mutation: DeveloperMutation): Promise<SigningSecretIssued> {
      let issuedSecret: string | null = null;
      const accepted = await receipts().execute<SigningSecretFacts>({
        identity: {
          workspaceId: actor.workspaceId,
          actorUserId: actor.actorUserId,
          command: "rotate_callback_signing_secret",
          clientIdempotencyKey: mutation.clientIdempotencyKey,
        },
        input: {},
        authorize: async () => {
          await requireApiAccess(actor);
        },
        beforeAccept: mutation.beforeAccept,
        mutate: async (tx: Prisma.TransactionClient) => {
          await requireApiAccess(actor);
          const rotated = await signingSecrets.issue(tx, actor.workspaceId);
          issuedSecret = rotated.secret;
          return {
            resourceType: "callback_signing_secret",
            resourceId: rotated.id,
            value: { id: rotated.id, createdAt: rotated.createdAt },
          };
        },
      });
      if (accepted.replayed || issuedSecret === null) {
        throw new CredentialAlreadyIssuedError(
          "This signing secret was already created, and a secret can't be shown a second time. Rotate it again to get a new one.",
          { credential: "callback_signing_secret", createdAt: accepted.value.createdAt },
        );
      }
      return { createdAt: accepted.value.createdAt, secret: issuedSecret };
    },

    /**
     * Registers a webhook endpoint. Only the intent is durable here; delivery stays with the
     * worker, which signs and sends through the pinned SSRF guard. A replay returns the webhook
     * as it was created.
     */
    async createWebhook(
      actor: ActorScope,
      input: { url: string; types: readonly WorkspaceEventType[] },
      mutation: DeveloperMutation,
    ): Promise<WebhookCreated> {
      const url = input.url.trim();
      const types = canonicalWebhookTypes(input.types);
      const state: { prepared: ReturnType<WebhookSubscriptions["prepareCreate"]> | null } = { prepared: null };
      try {
        const accepted = await receipts().execute<WebhookView>({
          identity: {
            workspaceId: actor.workspaceId,
            actorUserId: actor.actorUserId,
            command: "create_webhook",
            clientIdempotencyKey: mutation.clientIdempotencyKey,
          },
          input: { url, types },
          authorize: async () => {
            await requireApiAccess(actor);
          },
          beforeAccept: mutation.beforeAccept,
          // DNS resolution and URL sealing never hold the transaction.
          prepare: async () => {
            state.prepared = webhooks.prepareCreate({ url: await assertCallbackUrl(url), types });
          },
          mutate: async (tx: Prisma.TransactionClient) => {
            await requireApiAccess(actor);
            if (!state.prepared) throw new Error("The webhook URL was not prepared");
            const webhook = await webhooks.insert(tx, actor, state.prepared);
            return { resourceType: "webhook_subscription", resourceId: webhook.webhookId, value: webhook };
          },
        });
        return { webhook: accepted.value, replayed: accepted.replayed };
      } catch (error) {
        throw state.prepared ? await webhooks.explainInsertFailure(actor, state.prepared, error) : error;
      }
    },
  };
}

export type DeveloperCommands = ReturnType<typeof createDeveloperCommands>;
