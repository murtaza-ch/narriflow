import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@narriflow/db/client";
import type { ActorScope } from "./actor-scope";
import {
  createWebhookDeliveryProcessor,
  createWebhookSubscriptions,
  type WebhookCredential,
  type WebhookDisabledNotice,
  type WebhookNoticeResult,
  type WebhookSubscriptions,
} from "./webhook-subscription";

function requiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

let subscriptions: WebhookSubscriptions | null = null;
const service = () => (subscriptions ??= createWebhookSubscriptions({ prisma: requiredPrisma() }));

/** Production management of Webhook Subscriptions on the shared database. */
export const webhookSubscriptions = {
  list: (actor: ActorScope) => service().list(actor),
  create: (...args: Parameters<WebhookSubscriptions["create"]>) => service().create(...args),
  delete: (actor: ActorScope, id: string) => service().delete(actor, id),
  enable: (actor: ActorScope, id: string, credential?: WebhookCredential) => service().enable(actor, id, credential),
  test: (actor: ActorScope, id: string, credential?: WebhookCredential) => service().test(actor, id, credential),
};

const REASON_TEXT = {
  consecutive_failures: "Narriflow could not deliver 20 events in a row",
  cursor_expired: "Delivery fell more than 30 days behind, so events expired before they were sent",
  endpoint_gone: "The endpoint answered 410 Gone",
} as const;

/** Emails the person who should hear about a disabled subscription. Follows
 * the operator switch the other notification emails use. Nothing sent for a
 * reason that configuration can fix is `sent: false`, so the notice stays due. */
async function emailDisabledNotice(appBaseUrl: string | null, notice: WebhookDisabledNotice): Promise<WebhookNoticeResult> {
  if (process.env.NOTIFICATION_EMAILS_ENABLED?.trim() !== "true") return { sent: false, reason: "emails_disabled" };
  if (!appBaseUrl) return { sent: false, reason: "app_base_url_missing" };
  const email = await import("@narriflow/email/worker");
  const template = email.webhookDisabled({
    urlHost: notice.urlHost,
    reason: REASON_TEXT[notice.reason],
    settingsLink: new URL("/settings/api#webhooks", appBaseUrl).toString(),
  });
  const result = await email.sendEmail({ to: notice.to, ...template });
  if (result.sent) return { sent: true };
  if (result.error) throw new Error("Email provider refused the webhook notice");
  return { sent: false, reason: result.reason ?? "email_not_sent" };
}

let processor: ReturnType<typeof createWebhookDeliveryProcessor> | null = null;

/** The worker's production processor. `appBaseUrl` is where Settings lives. */
export function getWebhookDeliveryProcessor(appBaseUrl: () => string | null) {
  processor ??= createWebhookDeliveryProcessor({
    prisma: requiredPrisma(),
    leaseOwner: `webhooks:${randomUUID()}`,
    notifyDisabled: (notice) => emailDisabledNotice(appBaseUrl(), notice),
  });
  return processor;
}
