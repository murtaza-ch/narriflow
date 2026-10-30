import {
  claimWebhookDelivery,
  ClerkIdentityDeletedError,
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
    claimDelivery: claimWebhookDelivery,
    recordDeliveryLog: recordWebhookDeliveryLog,
    syncUser: async (payload) => {
      try {
        await syncClerkUserPayload(payload, options.clerkClient);
      } catch (error) {
        // A create/update that arrives after the identity's deletion is stale;
        // acknowledge it so Clerk stops redelivering.
        if (!(error instanceof ClerkIdentityDeletedError)) throw error;
        console.warn(
          JSON.stringify({ level: "warn", message: "clerk_stale_user_event_ignored", clerkId: error.clerkId }),
        );
      }
    },
    markUserDeleted: markUserDeletedByClerkId,
    // Purpose-bound and stable per Svix message: Resend returns the first result
    // for a repeated key, so a retry after a failed log write sends nothing new.
    relayEmail: (payload, deliveryId) =>
      relayClerkEmail(payload, { idempotencyKey: `clerk-email/${deliveryId}` }),
  };
}
