import { getOutboundDeliveryService } from "./outbound-delivery-runtime";
import type { ActorScope } from "./actor-scope";
import {
  createWebhookSubscriptions,
  type WebhookCredential,
  type WebhookSubscriptions,
} from "./webhook-subscription";
import { requirePrisma } from "./require-prisma";

const service = () => createWebhookSubscriptions({ prisma: requirePrisma(), delivery: getOutboundDeliveryService });

/** Production management of Webhook Subscriptions on the shared database. */
export const webhookSubscriptions = {
  list: (actor: ActorScope) => service().list(actor),
  create: (...args: Parameters<WebhookSubscriptions["create"]>) => service().create(...args),
  prepareCreate: (...args: Parameters<WebhookSubscriptions["prepareCreate"]>) => service().prepareCreate(...args),
  insert: (...args: Parameters<WebhookSubscriptions["insert"]>) => service().insert(...args),
  explainInsertFailure: (...args: Parameters<WebhookSubscriptions["explainInsertFailure"]>) => service().explainInsertFailure(...args),
  delete: (actor: ActorScope, id: string) => service().delete(actor, id),
  enable: (actor: ActorScope, id: string, credential?: WebhookCredential) => service().enable(actor, id, credential),
  test: (...args: Parameters<WebhookSubscriptions["test"]>) => service().test(...args),
  testStatus: (...args: Parameters<WebhookSubscriptions["testStatus"]>) => service().testStatus(...args),
};
