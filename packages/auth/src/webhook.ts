import { Webhook } from "svix";

export interface ClerkWebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

/**
 * Verifies a Clerk (Svix) delivery against the exact raw request text and
 * returns the parsed event. Throws on a bad signature, stale timestamp or
 * non-JSON body; callers must not reserialize the body before calling this.
 */
export function verifyClerkWebhook(
  rawBody: string,
  headers: SvixHeaders,
  secret: string,
): ClerkWebhookEvent {
  return new Webhook(secret).verify(rawBody, {
    "svix-id": headers.id,
    "svix-timestamp": headers.timestamp,
    "svix-signature": headers.signature,
  }) as ClerkWebhookEvent;
}
