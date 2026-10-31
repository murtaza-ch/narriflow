import { Prisma, type PrismaClient } from "@prisma/client";
import {
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
  CallbackSecretRequiredError,
  createCallbackCipher,
  prepareCallbackRegistration,
  type CallbackCipher,
  type CallbackRegistration,
} from "./completion-callback";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { IntegrationAdmissionError } from "./integration-admission";
import { appendWebhookSubscriptionDispatch } from "./notification-dispatch";

/** Management and notification ports. Delivery ordering, retries and ownership
 * belong to OutboundDelivery; subscriptions never hold a coordinator lease. */

/** One test event per webhook in this long. */
export const WEBHOOK_TEST_INTERVAL_MS = 5_000;
/** A subscription whose Workspace's plan lacks API access is held and looked at again after this long. */
export const WEBHOOK_PLAN_HOLD_MS = 15 * 60_000;

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
export function canonicalWebhookTypes(types: readonly WorkspaceEventType[]): WorkspaceEventType[] {
  return WORKSPACE_EVENT_TYPES.filter((type) => types.includes(type));
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
  apiKeyId?: string;
}

export interface WebhookSubscriptionDependencies {
  prisma: PrismaClient;
  cipher?: CallbackCipher;
  now?: () => Date;
  delivery?:()=>Pick<import("./outbound-delivery").OutboundDeliveryService,"admitTest"|"getTest">;
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

  type PreparedCreate = { registration: CallbackRegistration; types: WorkspaceEventType[] };

  function prepareCreate(input: { url: URL; types: readonly WorkspaceEventType[] }): PreparedCreate {
    return { registration: prepareCallbackRegistration(input.url, cipher()), types: canonicalWebhookTypes(input.types) };
  }

  async function insertSubscription(tx: Prisma.TransactionClient, actor: ActorScope, prepared: PreparedCreate) {
    const secret = await tx.callbackSigningSecret.findFirst({ where: { workspaceId: actor.workspaceId, retiresAt: null }, select: { id: true } });
    if (!secret) throw new CallbackSecretRequiredError();
    if (await tx.webhookSubscription.count({ where: { workspaceId: actor.workspaceId } }) >= WEBHOOK_SUBSCRIPTION_LIMIT) {
      throw failure("webhook_limit_reached", "conflict", `A workspace can have ${WEBHOOK_SUBSCRIPTION_LIMIT} webhooks. Delete one first.`);
    }
    const row = await tx.webhookSubscription.create({
      data: { workspaceId: actor.workspaceId, createdByUserId: actor.actorUserId, ...prepared.registration, types: prepared.types, lastDeliveredSeq: await headSeq(tx, actor.workspaceId), nextAttemptAt: now() },
    });
    await appendWebhookSubscriptionDispatch(tx, row);
    return webhookView(row);
  }

  async function explainInsertFailure(actor: ActorScope, prepared: PreparedCreate, error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) return error;
    const existing = await prisma.webhookSubscription.findFirst({ where: { workspaceId: actor.workspaceId, urlFingerprint: prepared.registration.urlFingerprint }, select: { id: true } });
    return failure("webhook_exists", "conflict", "This workspace already has a webhook for this URL. Delete it first to change its event types.", existing ? { webhookId: existing.id } : undefined);
  }

  return {
    async list(actor: ActorScope) {
      const rows = await prisma.webhookSubscription.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "asc" } });
      return rows.map(webhookView);
    },

    /** Starts at the head of the feed: a subscription receives what happens
     * after it exists. Earlier events are on `GET /events`. */
    async create(actor: ActorScope, input: { url: URL; types: readonly WorkspaceEventType[] }) {
      const prepared = prepareCreate(input);
      try {
        return await prisma.$transaction((tx) => insertSubscription(tx, actor, prepared));
      } catch (error) {
        throw await explainInsertFailure(actor, prepared, error);
      }
    },

    /** The first half of a receipt-backed create: seals the URL, outside any transaction. */
    prepareCreate,

    /** The write of a create, in the caller's transaction (the Operation Receipt's). A
     * refused insert goes through `explainInsertFailure` once that transaction has ended. */
    insert: insertSubscription,

    /** What to throw for an error raised by `insert` or `create`: a second webhook for the
     * same URL becomes `webhook_exists`; anything else is returned unchanged. */
    explainInsertFailure,

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
      return prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "WebhookSubscription" WHERE id = ${id}::uuid AND "workspaceId" = ${actor.workspaceId}::uuid FOR UPDATE`;
      const row = await tx.webhookSubscription.findFirst({ where: { id, workspaceId: actor.workspaceId } });
      if (!row) throw notFound();
      if (credential) requireWebhookTypeScopes(row.types as WorkspaceEventType[], credential.scopes);
      if (row.status !== "active") await tx.webhookSubscription.updateMany({
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
      const enabled = await tx.webhookSubscription.findUniqueOrThrow({ where: { id } });
      await appendWebhookSubscriptionDispatch(tx, enabled, `enable_${enabled.updatedAt.getTime().toString(36)}`);
      return webhookView(enabled);
      });
    },

    /** Admission returns a confirmed durable delivery; status reports the receipt later. */
    async test(actor: ActorScope, id: string, intent: string, credential?: WebhookCredential) {
      const row=await owned(actor,id);
      if(credential)requireWebhookTypeScopes(row.types as WorkspaceEventType[],credential.scopes);
      if(!dependencies.delivery)throw new Error("Notification delivery port required");
      return dependencies.delivery().admitTest(actor,id,intent,{capability:credential?"processing.consume":"api.manage",...(credential?.apiKeyId?{apiKeyId:credential.apiKeyId}:{})});
    },
    async testStatus(actor: ActorScope,id:string,deliveryId:string,credential?:WebhookCredential){
      const row=await owned(actor,id);
      if(credential)requireWebhookTypeScopes(row.types as WorkspaceEventType[],credential.scopes);
      if(!dependencies.delivery)throw new Error("Notification delivery port required");
      return dependencies.delivery().getTest(actor,id,deliveryId);
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


/** A durable maintenance wake names one disabled subscription. No table scan,
 * global pause or idle polling is needed; a skipped send returns its next timer. */
export function createWebhookDisabledNotifier(options:{prisma:PrismaClient;send(notice:WebhookDisabledNotice):Promise<WebhookNoticeResult>;now?:()=>Date}){
 return{async notify(id:string):Promise<{kind:"terminal"|"sent"}|{kind:"sleep";dueAt:Date}>{
  const at=options.now?.()??new Date();
  const won=await options.prisma.webhookSubscription.updateMany({where:{id,status:"disabled",disabledNotifiedAt:null},data:{disabledNotifiedAt:at}});
  if(won.count!==1)return{kind:"terminal"};
  const row=await options.prisma.webhookSubscription.findUnique({where:{id},select:{workspaceId:true,createdByUserId:true,urlHost:true,disabledReason:true,disabledAt:true,createdBy:{select:{primaryEmail:true,emailVerifiedAt:true}},workspace:{select:{owner:{select:{primaryEmail:true,emailVerifiedAt:true}}}}}});
  const stillMember=row?.createdByUserId?Boolean(await options.prisma.workspaceMember.findFirst({where:{workspaceId:row.workspaceId,userId:row.createdByUserId},select:{id:true}})):false;
  const recipient=[stillMember?row?.createdBy:null,row?.workspace.owner].find(user=>user?.primaryEmail&&user.emailVerifiedAt);
  if(!row||!row.disabledReason||!recipient?.primaryEmail)return{kind:"terminal"};
  let sent=false;
  try{sent=(await options.send({to:recipient.primaryEmail,webhookId:id,urlHost:row.urlHost,reason:row.disabledReason as WebhookDisabledReason})).sent;}
  catch{/* A provider refusal stays due without recording arbitrary error text. */}
  if(sent)return{kind:"sent"};
  const restored=await options.prisma.webhookSubscription.updateMany({where:{id,status:"disabled",disabledAt:row.disabledAt,disabledReason:row.disabledReason,disabledNotifiedAt:at},data:{disabledNotifiedAt:null}});
  return restored.count?{kind:"sleep",dueAt:new Date(at.getTime()+5*60000)}:{kind:"terminal"};
 }};
}
