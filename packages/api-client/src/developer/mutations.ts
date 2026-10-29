import { mutationOptions } from "@tanstack/react-query";
import type { CreateApiKeyRequest, CreateWebhookRequest } from "@narriflow/validators/api/developer";
import {
  type ApiRuntime,
  IDEMPOTENCY_KEY_HEADER,
  isApiError,
  scopedKey,
  type WorkspaceScope,
} from "../core";
import { createDeveloperClient } from "./client";
import { invalidateDeveloper } from "./queries";

const key = (scope: WorkspaceScope, command: string) => scopedKey(scope, "developer", command);
const clientFor = (api: ApiRuntime, scope: WorkspaceScope) => createDeveloperClient(api.transport.scoped(scope));

/**
 * The code a replay of a one-time issuance answers with: the credential exists
 * and cannot be shown again. Recovery is a new, explicit issuance.
 */
export const CREDENTIAL_ALREADY_ISSUED = "credential_already_issued";

export function isCredentialAlreadyIssued(error: unknown): boolean {
  return isApiError(error) && error.code === CREDENTIAL_ALREADY_ISSUED;
}

/**
 * Whether a failed command may still have changed something, so the lists should be read
 * again: the thing is gone (404), a conflict (409), a server fault, or no reply at all.
 * A plain refusal (validation, permission, plan, throttle) changed nothing.
 */
function mayHaveChanged(error: unknown): boolean {
  return !isApiError(error) || error.status === 0 || error.status === 404 || error.status === 409 || error.status >= 500;
}

/**
 * Creates an API key. The response carries the key's secret once: hold it in
 * component state, show it, and `reset()` the mutation; it must never enter the
 * QueryClient (`gcTime: 0` drops this mutation's result as soon as it is
 * unobserved) or a query key. Retries are never automatic. A manual retry
 * after a lost response reuses the intent's key, so the API answers
 * `credential_already_issued` instead of minting a second key; that ends the
 * intent, so the next attempt is a new, deliberate issuance.
 */
export function createApiKeyMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  const intent = api.createIntent<CreateApiKeyRequest>();
  return mutationOptions({
    mutationKey: key(scope, "create-api-key"),
    retry: false,
    gcTime: 0,
    mutationFn: async (input: CreateApiKeyRequest) =>
      (
        await client.workspace["api-keys"].$post(
          { json: input },
          { headers: { [IDEMPOTENCY_KEY_HEADER]: intent.keyFor(input) } },
        )
      ).json(),
    onSuccess: async () => {
      intent.complete();
      await invalidateDeveloper(api.queryClient, scope);
    },
    onError: async (error) => {
      if (!isCredentialAlreadyIssued(error)) return;
      // The key exists but its secret was lost with the response: show it in the list to revoke.
      intent.complete();
      await invalidateDeveloper(api.queryClient, scope);
    },
  });
}

export function revokeApiKeyMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "revoke-api-key"),
    mutationFn: async (keyId: string) =>
      (await client.workspace["api-keys"][":keyId"].$delete({ param: { keyId } })).json(),
    onSuccess: () => invalidateDeveloper(api.queryClient, scope),
  });
}

/**
 * Creates or rotates the callback signing secret; the previous one keeps signing
 * for 24 hours. Same one-time rules as `createApiKeyMutation`.
 */
export function rotateCallbackSigningSecretMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  const intent = api.createIntent<null>();
  return mutationOptions({
    mutationKey: key(scope, "rotate-signing-secret"),
    retry: false,
    gcTime: 0,
    mutationFn: async () =>
      (
        await client.workspace["callback-signing-secret"].rotate.$post(
          {},
          { headers: { [IDEMPOTENCY_KEY_HEADER]: intent.keyFor(null) } },
        )
      ).json(),
    onSuccess: async () => {
      intent.complete();
      await invalidateDeveloper(api.queryClient, scope);
    },
    onError: async (error) => {
      if (!isCredentialAlreadyIssued(error)) return;
      intent.complete();
      await invalidateDeveloper(api.queryClient, scope);
    },
  });
}

/** Registers a webhook. A retry after a lost response replays the same registration. */
export function createWebhookMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  const intent = api.createIntent<CreateWebhookRequest>();
  return mutationOptions({
    mutationKey: key(scope, "create-webhook"),
    mutationFn: async (input: CreateWebhookRequest) =>
      (
        await client.workspace.webhooks.$post(
          { json: input },
          { headers: { [IDEMPOTENCY_KEY_HEADER]: intent.keyFor(input) } },
        )
      ).json(),
    onSuccess: async () => {
      intent.complete();
      await invalidateDeveloper(api.queryClient, scope);
    },
    onError: async (error) => {
      if (mayHaveChanged(error)) await invalidateDeveloper(api.queryClient, scope);
    },
  });
}

export function deleteWebhookMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "delete-webhook"),
    mutationFn: async (webhookId: string) =>
      (await client.workspace.webhooks[":webhookId"].$delete({ param: { webhookId } })).json(),
    onSuccess: () => invalidateDeveloper(api.queryClient, scope),
    onError: async (error) => {
      if (mayHaveChanged(error)) await invalidateDeveloper(api.queryClient, scope);
    },
  });
}

export function enableWebhookMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "enable-webhook"),
    mutationFn: async (webhookId: string) =>
      (await client.workspace.webhooks[":webhookId"].enable.$post({ param: { webhookId } })).json(),
    onSuccess: () => invalidateDeveloper(api.queryClient, scope),
    onError: async (error) => {
      if (mayHaveChanged(error)) await invalidateDeveloper(api.queryClient, scope);
    },
  });
}

/** Sends one signed `webhook.test` event; the result says whether the endpoint answered 2xx. */
export function testWebhookMutation(api: ApiRuntime, scope: WorkspaceScope) {
  const client = clientFor(api, scope);
  return mutationOptions({
    mutationKey: key(scope, "test-webhook"),
    mutationFn: async (webhookId: string) =>
      (await client.workspace.webhooks[":webhookId"].test.$post({ param: { webhookId } })).json(),
    // The attempt is recorded on the subscription's delivery facts.
    onSettled: () => invalidateDeveloper(api.queryClient, scope),
  });
}
