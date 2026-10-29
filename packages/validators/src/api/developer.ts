import type { z } from "zod";
import { workspaceApiKeyActionSchema } from "../workspace-administration";
import type { SocialAccountSnapshot } from "../social";
import type { WebhookView } from "../webhook-subscription";

// Shared request schemas and response shapes of the developer routes: API keys,
// the callback signing secret, webhook subscriptions and the integrations overview.
// Dates are ISO strings.

export { createWebhookRequestSchema, type CreateWebhookRequest, type WebhookView } from "../webhook-subscription";

/** `POST /api/workspace/api-keys`. The scopes default to read-only. */
export const createApiKeyRequestSchema = workspaceApiKeyActionSchema;
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

/** A live key as Settings lists it. The secret is never part of it. */
export interface ApiKeySummary {
  id: string;
  name: string;
  /** The first characters of the key, enough to recognise it. */
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

/** `GET /api/workspace/api-keys`. */
export interface ApiKeysResult {
  keys: ApiKeySummary[];
}

/**
 * `POST /api/workspace/api-keys`. `secret` is shown once, in this response only;
 * nothing stores it. A replay of the same request answers 409
 * `credential_already_issued` instead.
 */
export interface ApiKeyIssued {
  key: Pick<ApiKeySummary, "id" | "name" | "prefix" | "scopes" | "createdAt">;
  secret: string;
}

/** `GET /api/workspace/callback-signing-secret`: when it was made, never the secret. */
export interface CallbackSigningStatus {
  current: { createdAt: string } | null;
  /** While the previous secret still signs after a rotation. */
  previousRetiresAt: string | null;
}

/** `POST /api/workspace/callback-signing-secret/rotate`. Shown once, like an API key. */
export interface CallbackSigningSecretIssued {
  createdAt: string;
  secret: string;
}

/** `GET /api/workspace/webhooks`. */
export interface WebhooksResult {
  webhooks: WebhookView[];
}

/** `POST /api/workspace/webhooks`. */
export interface WebhookCreatedResult {
  webhook: WebhookView;
  replayed: boolean;
}

/** `POST /api/workspace/webhooks/:webhookId/enable`. */
export interface WebhookEnabledResult {
  webhook: WebhookView;
}

/** `POST /api/workspace/webhooks/:webhookId/test`. */
export interface WebhookTestResult {
  eventId: string;
  delivered: boolean;
  status: number | null;
  durationMs: number;
}

/**
 * `GET /api/developer/settings`: everything the Developer access page shows,
 * read together. Without the plan's API access the keys and webhooks are empty
 * and `apiAccess` is false (the page offers the upgrade).
 */
export interface DeveloperSettings {
  apiAccess: boolean;
  keys: ApiKeySummary[];
  signing: CallbackSigningStatus;
  webhooks: WebhookView[];
}

/**
 * `GET /api/integrations`: the Integrations page. The key count and signing
 * status exist only for a member who may manage the API; for anyone else they
 * are `null` and nothing was read.
 */
export interface IntegrationsOverview {
  accounts: SocialAccountSnapshot[];
  apiKeys: { count: number } | null;
  signing: { configured: boolean } | null;
}
