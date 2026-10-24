import { z } from "zod";
import { WORKSPACE_EVENT_TYPES, workspaceEventTypeSchema } from "./workspace-event";

/** Webhook Subscriptions: a Workspace's HTTPS endpoints that receive its
 * Workspace Events as signed POSTs. The URL is sealed at rest and never
 * returned; views carry its host only. */

export const WEBHOOK_SUBSCRIPTION_LIMIT = 10;
/** Consecutive failed attempts that disable a subscription. */
export const WEBHOOK_MAX_CONSECUTIVE_FAILURES = 20;
/** `type` of the event that `POST /webhooks/{id}/test` sends. It is not in the feed. */
export const WEBHOOK_TEST_EVENT_TYPE = "webhook.test";

export const WEBHOOK_DISABLED_REASONS = ["consecutive_failures", "cursor_expired", "endpoint_gone"] as const;
export const webhookDisabledReasonSchema = z.enum(WEBHOOK_DISABLED_REASONS);
export type WebhookDisabledReason = z.infer<typeof webhookDisabledReasonSchema>;

export const createWebhookRequestSchema = z.strictObject({
  url: z.string().url().max(2_048).describe("Public HTTPS URL on port 443. Receives each matching event as a signed POST."),
  types: z.array(workspaceEventTypeSchema).min(1).max(WORKSPACE_EVENT_TYPES.length).describe("Event types to deliver. Queue proposals (social_post.proposed) and posting outcomes (social_post.finished) need the publishing:read scope."),
}).meta({ id: "CreateWebhookRequest" });
export type CreateWebhookRequest = z.infer<typeof createWebhookRequestSchema>;

const timestamp = z.string().datetime();

export const webhookViewSchema = z.strictObject({
  webhookId: z.string().uuid(),
  urlHost: z.string().describe("The endpoint's host. The full URL is sealed and never returned"),
  types: z.array(workspaceEventTypeSchema),
  status: z.enum(["active", "disabled"]),
  disabledReason: webhookDisabledReasonSchema.nullable(),
  disabledAt: timestamp.nullable(),
  lastDeliveredSeq: z.number().int().nonnegative().describe("Every matching event up to this seq has been acknowledged with a 2xx"),
  consecutiveFailures: z.number().int().nonnegative(),
  lastAttemptAt: timestamp.nullable(),
  lastResponseStatus: z.number().int().nullable().describe("Null when the last attempt got no response"),
  lastDeliveredAt: timestamp.nullable(),
  createdAt: timestamp,
}).meta({ id: "Webhook" });
export type WebhookView = z.infer<typeof webhookViewSchema>;
