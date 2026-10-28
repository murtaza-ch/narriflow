import {
  getWebhookDeliveryLog,
  markUserDeletedByClerkId,
  recordWebhookDeliveryLog,
  syncClerkUserPayload,
  verifyClerkWebhook,
  type ClerkUserDirectory,
} from "@narriflow/auth";
import { relayClerkEmail } from "@narriflow/email";
import type { ClerkWebhookDependencies } from "./webhook";

export interface ClerkWebhookRuntimeOptions {
  webhookSecret: string;
  /** Backend API client; confirms deletions when a first login collides with an old account's email. */
  clerkClient: ClerkUserDirectory;
}

export function createClerkWebhookDependencies(
  options: ClerkWebhookRuntimeOptions,
): ClerkWebhookDependencies {
  if (!options.webhookSecret) {
    throw new Error("CLERK_WEBHOOK_SECRET must be configured to receive Clerk webhooks");
  }

  return {
    webhookSecret: options.webhookSecret,
    verify: verifyClerkWebhook,
    getDeliveryLog: getWebhookDeliveryLog,
    recordDeliveryLog: recordWebhookDeliveryLog,
    syncUser: (payload) => syncClerkUserPayload(payload, options.clerkClient),
    markUserDeleted: markUserDeletedByClerkId,
    relayEmail: relayClerkEmail,
  };
}
