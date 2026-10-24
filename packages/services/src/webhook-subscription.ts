import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  WEBHOOK_MAX_CONSECUTIVE_FAILURES,
  WEBHOOK_SUBSCRIPTION_LIMIT,
  WEBHOOK_TEST_EVENT_TYPE,
  WORKSPACE_EVENT_PUBLISHING_TYPES,
  WORKSPACE_EVENT_TYPES,
  type WebhookDisabledReason,
  type WebhookView,
  type WorkspaceEventType,
} from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import {
  CALLBACK_LEASE_MS,
  CALLBACK_RETRY_DELAYS_MS,
  CallbackSecretRequiredError,
  classifyDelivery,
  createCallbackCipher,
  createCallbackSigningSecrets,
  deliverCallback,
  nextAttemptDelayMs,
  prepareCallbackRegistration,
  type CallbackCipher,
} from "./completion-callback";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { IntegrationAdmissionError } from "./integration-admission";
import type { HostResolver, PinnedTransport } from "./url-guard";
import { listWorkspaceEvents } from "./workspace-event";

/**
 * Webhook Subscription: a Workspace's HTTPS endpoint that receives its
 * Workspace Events as signed POSTs. It reuses Completion Callback delivery:
 * the sealed URL, the Workspace signing secret with rotation, Standard
 * Webhooks signing, the pinned guard and the retry backoff.
 *
 * Each subscription keeps a cursor, `lastDeliveredSeq`. A worker claims it with
 * a lease, reads the next matching events after the cursor, and sends them one
 * at a time in `seq` order. The cursor moves only after a 2xx, so a crash
 * between the response and the update redelivers that event: at least once.
 *
 * Order holds across workers because the lease is checked and renewed right
 * before every POST, in the same statement that requires the cursor to still
 * be below that event. A worker whose lease lapsed finds the row taken, or the
 * cursor moved past, and sends nothing.
 */

/** One test event per webhook in this long. */
export const WEBHOOK_TEST_INTERVAL_MS = 5_000;
/** Subscriptions drained at once. The lease keeps any one subscription to a single worker. */
export const WEBHOOK_CONCURRENCY = 4;
/** A tick stops claiming, and stops between events, after this long. */
export const WEBHOOK_TICK_BUDGET_MS = 20_000;
/** A caught-up subscription is looked at again after this long. */
export const WEBHOOK_IDLE_POLL_MS = 5_000;
/** Events sent per claim. */
const EVENTS_PER_CLAIM = 20;
/** A skipped disabled-notice (emails off, no base URL) is tried again after this long. */
const NOTICE_RETRY_MS = 5 * 60_000;

/** What the endpoint receives. `webhook.test` has `seq` 0 and an empty subject. */
export interface WebhookPayload {
  id: string;
  seq: number;
  type: WorkspaceEventType | typeof WEBHOOK_TEST_EVENT_TYPE;
  version: 1;
  occurredAt: string;
  workspaceId: string;
  subject: unknown;
}

type Db = Pick<PrismaClient, "workspaceEvent" | "workspaceEventCounter">;

function failure<C extends string>(code: C, kind: "missing" | "conflict", message: string, details?: Record<string, string | number>) {
  return new ExpectedDomainFailureError({ code, kind, message, details });
}

const notFound = () => failure("webhook_not_found", "missing", "This webhook doesn't exist in the key's workspace. List webhooks for current IDs.");

/** The last `seq` ever written for the Workspace; 0 before the first event. */
async function headSeq(db: Db, workspaceId: string) {
  const counter = await db.workspaceEventCounter.findUnique({ where: { workspaceId }, select: { lastSeq: true } });
  return counter?.lastSeq ?? 0n;
}

/** The lowest cursor that still loses nothing. Retention deletes a prefix of
 * the log, so the oldest retained event names the gap; with nothing retained
 * everything up to the head is gone. A cursor below the floor missed events. */
async function retentionFloor(db: Db, workspaceId: string, head: bigint) {
  const oldest = await db.workspaceEvent.findFirst({ where: { workspaceId }, orderBy: { seq: "asc" }, select: { seq: true } });
  return oldest ? oldest.seq - 1n : head;
}

/** Publishing outcomes also need `publishing:read`, as in the feed. */
export function requireWebhookTypeScopes(types: readonly WorkspaceEventType[], scopes: readonly string[]) {
  if (types.some((type) => WORKSPACE_EVENT_PUBLISHING_TYPES.includes(type)) && !scopes.includes("publishing:read")) {
    throw new IntegrationAdmissionError("scope_required", "This credential requires the publishing:read scope", { scope: "publishing:read" });
  }
}

type Row = Prisma.WebhookSubscriptionGetPayload<object>;

export function webhookView(row: Row): WebhookView {
  return {
    webhookId: row.id,
    urlHost: row.urlHost,
    types: row.types as WorkspaceEventType[],
    status: row.status as WebhookView["status"],
    disabledReason: row.disabledReason as WebhookDisabledReason | null,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    lastDeliveredSeq: Number(row.lastDeliveredSeq),
    consecutiveFailures: row.consecutiveFailures,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastResponseStatus: row.lastResponseStatus,
    lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What the calling credential may see. Browser sessions pass none. */
export interface WebhookCredential {
  scopes: readonly string[];
}

export interface WebhookSubscriptionDependencies {
  prisma: PrismaClient;
  cipher?: CallbackCipher;
  now?: () => Date;
  transport?: PinnedTransport;
  resolver?: HostResolver;
}

/** The management side, called by REST and Settings. */
export function createWebhookSubscriptions(dependencies: WebhookSubscriptionDependencies) {
  const { prisma } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const cipher = () => dependencies.cipher ?? createCallbackCipher();

  async function owned(actor: ActorScope, id: string) {
    const row = await prisma.webhookSubscription.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!row) throw notFound();
    return row;
  }

  return {
    async list(actor: ActorScope) {
      const rows = await prisma.webhookSubscription.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "asc" } });
      return rows.map(webhookView);
    },

    /** Starts at the head of the feed: a subscription receives what happens
     * after it exists. Earlier events are on `GET /events`. */
    async create(actor: ActorScope, input: { url: URL; types: readonly WorkspaceEventType[] }) {
      const registration = prepareCallbackRegistration(input.url, cipher());
      const types = WORKSPACE_EVENT_TYPES.filter((type) => input.types.includes(type));
      try {
        return webhookView(await prisma.$transaction(async (tx) => {
          const secret = await tx.callbackSigningSecret.findFirst({ where: { workspaceId: actor.workspaceId, retiresAt: null }, select: { id: true } });
          if (!secret) throw new CallbackSecretRequiredError();
          if (await tx.webhookSubscription.count({ where: { workspaceId: actor.workspaceId } }) >= WEBHOOK_SUBSCRIPTION_LIMIT) {
            throw failure("webhook_limit_reached", "conflict", `A workspace can have ${WEBHOOK_SUBSCRIPTION_LIMIT} webhooks. Delete one first.`);
          }
          return tx.webhookSubscription.create({
            data: { workspaceId: actor.workspaceId, createdByUserId: actor.actorUserId, ...registration, types, lastDeliveredSeq: await headSeq(tx, actor.workspaceId), nextAttemptAt: now() },
          });
        }));
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
        const existing = await prisma.webhookSubscription.findFirst({ where: { workspaceId: actor.workspaceId, urlFingerprint: registration.urlFingerprint }, select: { id: true } });
        throw failure("webhook_exists", "conflict", "This workspace already has a webhook for this URL. Delete it first to change its event types.", existing ? { webhookId: existing.id } : undefined);
      }
    },

    async delete(actor: ActorScope, id: string) {
      const deleted = await prisma.webhookSubscription.deleteMany({ where: { id, workspaceId: actor.workspaceId } });
      if (deleted.count === 0) throw notFound();
      return { webhookId: id };
    },

    /** Resumes from where delivery stopped. Events that expired while it was
     * disabled are gone, so the next drain moves the cursor to the oldest
     * retained one, deciding at that moment instead of failing the retention
     * check again. `credential` limits what the caller may see, as on create. */
    async enable(actor: ActorScope, id: string, credential?: WebhookCredential) {
      const row = await owned(actor, id);
      if (credential) requireWebhookTypeScopes(row.types as WorkspaceEventType[], credential.scopes);
      if (row.status === "active") return webhookView(row);
      await prisma.webhookSubscription.updateMany({
        where: { id, workspaceId: actor.workspaceId, status: "disabled" },
        data: {
          status: "active",
          disabledReason: null,
          disabledAt: null,
          disabledNotifiedAt: null,
          skipExpiredOnResume: true,
          consecutiveFailures: 0,
          nextAttemptAt: now(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      return webhookView(await owned(actor, id));
    },

    /** Sends one `webhook.test` event now, signed like any other. It is not
     * part of the feed and moves no cursor, so it works on a disabled one.
     * One per webhook every few seconds: the endpoint is someone else's server. */
    async test(actor: ActorScope, id: string, credential?: WebhookCredential) {
      const row = await owned(actor, id);
      if (credential) requireWebhookTypeScopes(row.types as WorkspaceEventType[], credential.scopes);
      const at = now();
      const claimed = await prisma.webhookSubscription.updateMany({
        where: { id, workspaceId: actor.workspaceId, OR: [{ lastTestedAt: null }, { lastTestedAt: { lte: new Date(at.getTime() - WEBHOOK_TEST_INTERVAL_MS) } }] },
        data: { lastTestedAt: at },
      });
      if (claimed.count === 0) {
        throw new ExpectedDomainFailureError({
          code: "webhook_test_throttled",
          kind: "rate_limited",
          message: "A test event was just sent to this webhook. Wait a few seconds and try again.",
          retryAfterSeconds: WEBHOOK_TEST_INTERVAL_MS / 1000,
        });
      }
      const secrets = await createCallbackSigningSecrets({ prisma, cipher: cipher(), now }).signingSecrets(actor.workspaceId);
      if (secrets.length === 0) throw new CallbackSecretRequiredError();
      const payload: WebhookPayload = { id: randomUUID(), seq: 0, type: WEBHOOK_TEST_EVENT_TYPE, version: 1, occurredAt: at.toISOString(), workspaceId: actor.workspaceId, subject: {} };
      const result = await deliverCallback({ url: cipher().open(row.encryptedUrl), payload, secrets, now: at, transport: dependencies.transport, resolver: dependencies.resolver });
      return { eventId: payload.id, delivered: classifyDelivery(result.status) === "delivered", status: result.status, durationMs: result.durationMs };
    },
  };
}

export type WebhookSubscriptions = ReturnType<typeof createWebhookSubscriptions>;


/** Who to tell when a subscription is disabled. */
export interface WebhookDisabledNotice {
  to: string;
  webhookId: string;
  urlHost: string;
  reason: WebhookDisabledReason;
}

/** `sent: false` means nothing went out and the notice stays due, such as when
 * emails are switched off or the app URL is unknown. A throw means the send
 * failed and is not retried. */
export type WebhookNoticeResult = { sent: true } | { sent: false; reason: string };

export interface WebhookDeliveryProcessorDependencies {
  prisma: PrismaClient;
  leaseOwner: string;
  now?: () => Date;
  random?: () => number;
  cipher?: CallbackCipher;
  transport?: PinnedTransport;
  resolver?: HostResolver;
  log?: (entry: Record<string, unknown>) => void;
  /** Emails the person who should hear that a subscription was disabled. */
  notifyDisabled?: (notice: WebhookDisabledNotice) => Promise<WebhookNoticeResult>;
}

/** Delay before retrying after `failures` consecutive failures. The callback
 * backoff has nine steps; later failures keep its last one (a day). */
function retryDelayMs(failures: number, random: () => number) {
  return nextAttemptDelayMs(Math.min(failures, CALLBACK_RETRY_DELAYS_MS.length), random) ?? CALLBACK_RETRY_DELAYS_MS.at(-1)!;
}

/** The worker side. A subscription is claimed one at a time, right before it
 * is drained, and its lease is checked and renewed before every POST. Every
 * update is fenced by the lease owner and `active` status, so a worker that
 * lost its lease, or a subscription that was disabled or deleted meanwhile,
 * sends nothing more and can't move the cursor. */
export function createWebhookDeliveryProcessor(dependencies: WebhookDeliveryProcessorDependencies) {
  const { prisma, leaseOwner } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  const cipher = dependencies.cipher ?? createCallbackCipher();
  const secrets = createCallbackSigningSecrets({ prisma, cipher, now });
  const log = dependencies.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  const release = { leaseOwner: null, leaseExpiresAt: null };
  const leaseUntil = (at: Date) => new Date(at.getTime() + CALLBACK_LEASE_MS);

  /** Takes the most overdue free subscription, or null when none is due. A
   * lane that loses a race tries the next candidate. */
  async function claimOne() {
    const at = now();
    const free = { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: at } }] };
    const candidates = await prisma.webhookSubscription.findMany({
      where: { status: "active", nextAttemptAt: { lte: at }, ...free },
      orderBy: { nextAttemptAt: "asc" },
      take: WEBHOOK_CONCURRENCY * 2,
      select: { id: true },
    });
    for (const candidate of candidates) {
      const won = await prisma.webhookSubscription.updateMany({
        where: { id: candidate.id, status: "active", ...free },
        data: { leaseOwner, leaseExpiresAt: leaseUntil(at) },
      });
      if (won.count === 1) return prisma.webhookSubscription.findUniqueOrThrow({ where: { id: candidate.id } });
    }
    return null;
  }

  /** Sends the claimed subscription's next events until the page, the tick's
   * `deadline` (a `performance.now()` time), a failure, or a lost lease ends
   * it. Returns how many it delivered. */
  async function drain(row: Row, deadline: number) {
    const held = { id: row.id, leaseOwner, status: "active" };
    const mark = { workspaceId: row.workspaceId, webhookId: row.id, host: row.urlHost };
    const disable = async (reason: WebhookDisabledReason, data: Prisma.WebhookSubscriptionUpdateManyMutationInput) => {
      const updated = await prisma.webhookSubscription.updateMany({
        where: held,
        data: { ...release, ...data, status: "disabled", disabledReason: reason, disabledAt: now() },
      });
      log({ level: "warn", message: "webhook_subscription_disabled", ...mark, reason, ...(updated.count === 0 ? { leaseLost: true } : {}) });
    };

    // Read the head before the events: everything at or below it is committed,
    // so an empty page proves nothing matching lies between the cursor and it.
    const head = await headSeq(prisma, row.workspaceId);
    const floor = await retentionFloor(prisma, row.workspaceId, head);
    let cursor = row.lastDeliveredSeq;
    if (row.skipExpiredOnResume) {
      // Re-enabled: whatever expired while it was disabled is gone, so resume
      // from the oldest event still kept instead of disabling it again.
      if (cursor < floor) cursor = floor;
      const resumed = await prisma.webhookSubscription.updateMany({ where: held, data: { skipExpiredOnResume: false, lastDeliveredSeq: cursor } });
      if (resumed.count === 0) return 0;
      if (cursor > row.lastDeliveredSeq) log({ level: "warn", message: "webhook_subscription_resumed_past_expired", ...mark, skippedThroughSeq: Number(cursor) });
    } else if (cursor < floor) {
      await disable("cursor_expired", {});
      return 0;
    }

    const page = await listWorkspaceEvents(prisma, row, { after: String(cursor), limit: EVENTS_PER_CLAIM, types: row.types as WorkspaceEventType[] });
    if (page.data.length === 0) {
      // Caught up. Moving the cursor to the head keeps events of other types
      // from looking like a retention gap once they expire.
      await prisma.webhookSubscription.updateMany({
        where: { ...held, lastDeliveredSeq: { lte: head } },
        data: { ...release, lastDeliveredSeq: head, nextAttemptAt: new Date(now().getTime() + WEBHOOK_IDLE_POLL_MS) },
      });
      return 0;
    }

    const signing = await secrets.signingSecrets(row.workspaceId);
    const url = cipher.open(row.encryptedUrl);
    let failures = row.consecutiveFailures;
    let delivered = 0;
    for (const event of page.data) {
      const seq = BigInt(event.seq);
      if (performance.now() >= deadline) {
        // The tick is out of time: leave the rest due at once for the next one.
        await prisma.webhookSubscription.updateMany({ where: held, data: { ...release, nextAttemptAt: now() } });
        return delivered;
      }
      // Still ours, still active, and this event not yet acknowledged? Renew
      // the lease and only then POST. If another worker took over, or the
      // subscription was disabled or deleted, nothing is sent.
      const holding = await prisma.webhookSubscription.updateMany({
        where: { ...held, lastDeliveredSeq: { lt: seq } },
        data: { leaseExpiresAt: leaseUntil(now()) },
      });
      if (holding.count === 0) {
        log({ level: "warn", message: "webhook_delivery_stopped", ...mark, seq: event.seq, reason: "lease_lost_or_changed" });
        return delivered;
      }

      const payload: WebhookPayload = { id: event.id, seq: event.seq, type: event.type, version: 1, occurredAt: event.occurredAt, workspaceId: row.workspaceId, subject: event.subject };
      const result = signing.length
        ? await deliverCallback({ url, payload, secrets: signing, now: now(), transport: dependencies.transport, resolver: dependencies.resolver })
        : { status: null, durationMs: 0 };
      const disposition = classifyDelivery(result.status);
      const at = now();
      const attempt = { lastAttemptAt: at, lastResponseStatus: result.status };
      const entry = { ...mark, eventId: event.id, seq: event.seq, type: event.type, status: result.status, durationMs: result.durationMs, ...(signing.length ? {} : { reason: "signing_secret_missing" }) };

      if (disposition === "delivered") {
        const updated = await prisma.webhookSubscription.updateMany({
          where: { ...held, lastDeliveredSeq: { lt: seq } },
          data: { ...attempt, lastDeliveredAt: at, lastDeliveredSeq: seq, consecutiveFailures: 0, leaseExpiresAt: leaseUntil(at) },
        });
        log({ level: "info", message: "webhook_delivery_attempt", ...entry, disposition: "delivered", ...(updated.count === 0 ? { leaseLost: true } : {}) });
        if (updated.count === 0) return delivered;
        failures = 0;
        delivered += 1;
        continue;
      }

      failures += 1;
      log({ level: "warn", message: "webhook_delivery_attempt", ...entry, disposition: disposition === "cancelled" ? "endpoint_gone" : "retry", consecutiveFailures: failures });
      if (disposition === "cancelled") await disable("endpoint_gone", { ...attempt, consecutiveFailures: failures });
      else if (failures >= WEBHOOK_MAX_CONSECUTIVE_FAILURES) await disable("consecutive_failures", { ...attempt, consecutiveFailures: failures });
      else {
        await prisma.webhookSubscription.updateMany({
          where: held,
          data: { ...release, ...attempt, consecutiveFailures: failures, nextAttemptAt: new Date(at.getTime() + retryDelayMs(failures, random)) },
        });
      }
      return delivered;
    }
    // The page was sent in full: come back at once for whatever followed it.
    await prisma.webhookSubscription.updateMany({ where: held, data: { ...release, nextAttemptAt: now() } });
    return delivered;
  }

  /** Drains due subscriptions, one claim at a time, in a few lanes at once
   * until nothing is due or the tick's budget is spent. A slow endpoint holds
   * one lane, never the others, and never two lanes at once. Returns the
   * number of events delivered. */
  async function deliver(options: { budgetMs?: number; concurrency?: number } = {}) {
    const deadline = performance.now() + (options.budgetMs ?? WEBHOOK_TICK_BUDGET_MS);
    let delivered = 0;
    const lane = async () => {
      while (performance.now() < deadline) {
        const row = await claimOne();
        if (!row) return;
        try {
          const count = await drain(row, deadline);
          delivered += count;
        } catch (error) {
          // The lease expires and the subscription is claimed again. One bad
          // row doesn't stop the others.
          log({ level: "error", message: "webhook_delivery_failed", workspaceId: row.workspaceId, webhookId: row.id, host: row.urlHost, errorName: error instanceof Error ? error.name : "unknown" });
        }
      }
    };
    await Promise.all(Array.from({ length: options.concurrency ?? WEBHOOK_CONCURRENCY }, lane));
    return delivered;
  }

  let noticesPausedUntil = 0;

  /** Emails the creator while they are still a member, otherwise the
   * Workspace owner, once per disabling. A send that goes out, or fails, is
   * final. One that was skipped (emails off, no app URL) is unmarked, logged,
   * and tried again a few minutes later. */
  async function notifyDisabled(batchSize = 10) {
    const { notifyDisabled: send } = dependencies;
    if (!send || now().getTime() < noticesPausedUntil) return 0;
    const due = await prisma.webhookSubscription.findMany({ where: { status: "disabled", disabledNotifiedAt: null }, take: batchSize, select: { id: true } });
    let notified = 0;
    for (const { id } of due) {
      const markedAt = now();
      const won = await prisma.webhookSubscription.updateMany({ where: { id, status: "disabled", disabledNotifiedAt: null }, data: { disabledNotifiedAt: markedAt } });
      if (won.count !== 1) continue;
      const row = await prisma.webhookSubscription.findUnique({
        where: { id },
        select: {
          workspaceId: true,
          createdByUserId: true,
          urlHost: true,
          disabledReason: true,
          createdBy: { select: { primaryEmail: true, emailVerifiedAt: true } },
          workspace: { select: { owner: { select: { primaryEmail: true, emailVerifiedAt: true } } } },
        },
      });
      const stillMember = row?.createdByUserId
        ? Boolean(await prisma.workspaceMember.findFirst({ where: { workspaceId: row.workspaceId, userId: row.createdByUserId }, select: { id: true } }))
        : false;
      const recipient = [stillMember ? row?.createdBy : null, row?.workspace.owner].find((user) => user?.primaryEmail && user.emailVerifiedAt);
      if (!row || !row.disabledReason || !recipient?.primaryEmail) {
        log({ level: "warn", message: "webhook_disabled_notice_skipped", webhookId: id, reason: "no_verified_recipient" });
        continue;
      }
      try {
        const result = await send({ to: recipient.primaryEmail, webhookId: id, urlHost: row.urlHost, reason: row.disabledReason as WebhookDisabledReason });
        if (result.sent) {
          notified += 1;
          continue;
        }
        await prisma.webhookSubscription.updateMany({ where: { id, status: "disabled", disabledNotifiedAt: markedAt }, data: { disabledNotifiedAt: null } });
        noticesPausedUntil = now().getTime() + NOTICE_RETRY_MS;
        log({ level: "warn", message: "webhook_disabled_notice_skipped", webhookId: id, reason: result.reason, retryAfterMs: NOTICE_RETRY_MS });
        break;
      } catch (error) {
        log({ level: "error", message: "webhook_disabled_notice_failed", webhookId: id, errorName: error instanceof Error ? error.name : "unknown" });
      }
    }
    return notified;
  }

  return { deliver, notifyDisabled };
}
