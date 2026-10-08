import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import type { ActorScope } from "./actor-scope";
import {
  buildCallbackPayload,
  CALLBACK_SECRET_OVERLAP_MS,
  classifyDelivery,
  createCallbackCipher,
  deliverCallback,
  generateCallbackSigningSecret,
  nextAttemptDelayMs,
  nextObservationDelayMs,
  prepareCallbackRegistration,
  type CallbackCipher,
  type CallbackPayload,
  type CallbackRegistration,
} from "./completion-callback";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import type { OperationKind, OperationStatusReader } from "./operation-status";
import { operationStatusService } from "./operation-status-runtime";
import { OperationIdempotencyConflictError, type IntegrationMutation, type ReceiptCallback } from "./operation-receipt";
import type { HostResolver, PinnedTransport } from "./url-guard";
import { uuidV5 } from "./uuid-v5";

const CALLBACK_EVENT_NAMESPACE = "3b9c5e21-7d4f-5a86-b1c2-9e0f7a6d5c4b";
const LEASE_MS = 60_000;

function requiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

/** Event IDs derive from the acceptance (receipt or Upload Session), so every
 * replay of an acceptance reports the same event ID without another read. */
export function callbackEventId(acceptanceId: string) {
  return uuidV5(CALLBACK_EVENT_NAMESPACE, acceptanceId);
}

export class CallbackSecretRequiredError extends ExpectedDomainFailureError<"callback_secret_required"> {
  constructor() {
    super({
      code: "callback_secret_required",
      kind: "conflict",
      message: "Create a callback signing secret in Settings → API before requesting callbacks",
    });
    this.name = "CallbackSecretRequiredError";
  }
}

type Tx = Prisma.TransactionClient;

/** Inserts one waiting callback. Refuses before any work commits when the
 * Workspace has no current signing secret. */
async function insertCompletionCallback(
  tx: Tx,
  input: {
    workspaceId: string;
    operation: { kind: OperationKind; id: string };
    acceptance: { receiptId: string } | { uploadSessionId: string };
    registration: CallbackRegistration;
  },
) {
  const secret = await tx.callbackSigningSecret.findFirst({ where: { workspaceId: input.workspaceId, retiresAt: null }, select: { id: true } });
  if (!secret) throw new CallbackSecretRequiredError();
  const acceptanceId = "receiptId" in input.acceptance ? input.acceptance.receiptId : input.acceptance.uploadSessionId;
  await tx.completionCallback.create({
    data: {
      workspaceId: input.workspaceId,
      operationKind: input.operation.kind,
      operationId: input.operation.id,
      ...input.acceptance,
      ...input.registration,
      eventId: callbackEventId(acceptanceId),
    },
  });
}

/** The receipt executor hook for a command that starts an operation. */
export function receiptCallback<T>(
  workspaceId: string,
  mutation: IntegrationMutation | undefined,
  operationOf: (value: T) => { kind: OperationKind; id: string },
): ReceiptCallback<Tx, T> | undefined {
  if (!mutation?.callback) return undefined;
  const registration = prepareCallbackRegistration(mutation.callback.url);
  return {
    fingerprint: registration.urlFingerprint,
    register: (tx, accepted) =>
      insertCompletionCallback(tx, { workspaceId, operation: operationOf(accepted.value), acceptance: { receiptId: accepted.receiptId }, registration }),
  };
}

/** Upload intake callbacks: inserted with the finalization intent when
 * finalize claims the session, otherwise registered idempotently. Each Upload
 * Session has at most one callback; another URL is a conflict. */
export async function registerUploadCallback(
  tx: Tx,
  input: { workspaceId: string; sessionId: string; registration: CallbackRegistration },
) {
  const existing = await tx.completionCallback.findUnique({ where: { uploadSessionId: input.sessionId }, select: { urlFingerprint: true } });
  if (existing) {
    if (existing.urlFingerprint !== input.registration.urlFingerprint) throw new OperationIdempotencyConflictError();
    return;
  }
  await insertCompletionCallback(tx, {
    workspaceId: input.workspaceId,
    operation: { kind: "intake", id: input.sessionId },
    acceptance: { uploadSessionId: input.sessionId },
    registration: input.registration,
  });
}

/** Registers an upload callback outside a finalization claim. A concurrent
 * registration of the same session is resolved by re-reading it. */
export async function ensureUploadCallback(input: { workspaceId: string; sessionId: string; registration: CallbackRegistration }) {
  const prisma = requiredPrisma();
  try {
    await prisma.$transaction((tx) => registerUploadCallback(tx, input));
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    await prisma.$transaction((tx) => registerUploadCallback(tx, input));
  }
}

export function prepareUploadCallback(mutation: Pick<IntegrationMutation, "callback"> | undefined) {
  return mutation?.callback ? prepareCallbackRegistration(mutation.callback.url) : undefined;
}

/** Signing secrets: one current secret per Workspace. Rotation keeps the
 * previous one signing for the overlap window and retires any older one. */
export function createCallbackSigningSecrets(dependencies: { prisma?: PrismaClient; cipher?: CallbackCipher; now?: () => Date } = {}) {
  const prisma = () => dependencies.prisma ?? requiredPrisma();
  const cipher = () => dependencies.cipher ?? createCallbackCipher();
  const now = dependencies.now ?? (() => new Date());
  return {
    async status(workspaceId: string) {
      const at = now();
      const rows = await prisma().callbackSigningSecret.findMany({
        where: { workspaceId, OR: [{ retiresAt: null }, { retiresAt: { gt: at } }] },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, retiresAt: true },
      });
      const current = rows.find((row) => row.retiresAt === null);
      const previous = rows.find((row) => row.retiresAt !== null);
      return { current: current ? { createdAt: current.createdAt.toISOString() } : null, previousRetiresAt: previous?.retiresAt?.toISOString() ?? null };
    },
    /** Returns the new secret once; it is stored sealed and never shown again. */
    async rotate(workspaceId: string) {
      const secret = generateCallbackSigningSecret();
      const at = now();
      await prisma().$transaction(async (tx) => {
        // Serialize rotations so a Workspace never has two current secrets.
        await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
        await tx.callbackSigningSecret.deleteMany({ where: { workspaceId, retiresAt: { lte: at } } });
        await tx.callbackSigningSecret.updateMany({ where: { workspaceId, retiresAt: { gt: at } }, data: { retiresAt: at } });
        await tx.callbackSigningSecret.updateMany({ where: { workspaceId, retiresAt: null }, data: { retiresAt: new Date(at.getTime() + CALLBACK_SECRET_OVERLAP_MS) } });
        await tx.callbackSigningSecret.create({ data: { workspaceId, encryptedSecret: cipher().seal(secret), createdAt: at } });
      });
      return { secret, createdAt: at.toISOString() };
    },
    /** Current secret first, then any still in its overlap window. */
    async signingSecrets(workspaceId: string) {
      const at = now();
      const rows = await prisma().callbackSigningSecret.findMany({
        where: { workspaceId, OR: [{ retiresAt: null }, { retiresAt: { gt: at } }] },
        orderBy: [{ retiresAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
        select: { encryptedSecret: true },
      });
      return rows.map((row) => cipher().open(row.encryptedSecret));
    },
  };
}

export const callbackSigningSecrets = createCallbackSigningSecrets();

export interface CompletionCallbackProcessorDependencies {
  prisma: PrismaClient;
  readTrusted: OperationStatusReader["readTrusted"];
  leaseOwner: string;
  now?: () => Date;
  random?: () => number;
  cipher?: CallbackCipher;
  transport?: PinnedTransport;
  resolver?: HostResolver;
  log?: (entry: Record<string, unknown>) => void;
}

/** The worker side: observe waiting callbacks through the trusted Operation
 * Status read, freeze terminal events, and deliver pending ones. Every update
 * is fenced by the lease owner and state, so a worker that lost its lease
 * can't overwrite a newer outcome. */
export function createCompletionCallbackProcessor(dependencies: CompletionCallbackProcessorDependencies) {
  const { prisma, leaseOwner } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  const cipher = dependencies.cipher ?? createCallbackCipher();
  const secrets = createCallbackSigningSecrets({ prisma, cipher, now });
  const log = dependencies.log ?? ((entry) => console.warn(JSON.stringify(entry)));

  async function claim(state: "waiting" | "pending", batchSize: number) {
    const at = now();
    const due = state === "waiting" ? { nextObservationAt: { lte: at } } : { nextAttemptAt: { lte: at } };
    const free = { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: at } }] };
    const candidates = await prisma.completionCallback.findMany({
      where: { state, ...due, ...free },
      orderBy: state === "waiting" ? { nextObservationAt: "asc" } : { nextAttemptAt: "asc" },
      take: batchSize,
      select: { id: true },
    });
    const claimed = [];
    for (const candidate of candidates) {
      const won = await prisma.completionCallback.updateMany({
        where: { id: candidate.id, state, ...free },
        data: { leaseOwner, leaseExpiresAt: new Date(at.getTime() + LEASE_MS) },
      });
      if (won.count === 1) claimed.push(await prisma.completionCallback.findUniqueOrThrow({ where: { id: candidate.id } }));
    }
    return claimed;
  }

  const fenced = (id: string, state: "waiting" | "pending") => ({ id, state, leaseOwner });
  const release = { leaseOwner: null, leaseExpiresAt: null };

  async function observe(batchSize = 25) {
    let frozen = 0;
    for (const row of await claim("waiting", batchSize)) {
      const status = await dependencies.readTrusted({ workspaceId: row.workspaceId }, { kind: row.operationKind as OperationKind, id: row.operationId });
      const at = now();
      const payload = buildCallbackPayload({ eventId: row.eventId, workspaceId: row.workspaceId, createdAt: at, status });
      if (!payload) {
        await prisma.completionCallback.updateMany({
          where: fenced(row.id, "waiting"),
          data: { ...release, observationCount: row.observationCount + 1, nextObservationAt: new Date(at.getTime() + nextObservationDelayMs(row.observationCount)) },
        });
        continue;
      }
      const updated = await prisma.completionCallback.updateMany({
        where: fenced(row.id, "waiting"),
        data: { ...release, state: "pending", payload: payload as unknown as Prisma.InputJsonValue, nextAttemptAt: at },
      });
      frozen += updated.count;
    }
    return frozen;
  }

  async function deliver(batchSize = 25) {
    let settled = 0;
    for (const row of await claim("pending", batchSize)) {
      const payload = row.payload as unknown as CallbackPayload;
      const signing = await secrets.signingSecrets(row.workspaceId);
      const attempt = row.attempts + 1;
      const result = signing.length
        ? await deliverCallback({ url: cipher.open(row.encryptedUrl), payload, secrets: signing, now: now(), transport: dependencies.transport, resolver: dependencies.resolver })
        : { status: null, durationMs: 0 };
      const disposition = classifyDelivery(result.status);
      const at = now();
      const delay = disposition === "retry" ? nextAttemptDelayMs(attempt, random) : null;
      const state = disposition === "delivered" ? "delivered" : disposition === "cancelled" ? "cancelled" : delay === null ? "failed" : "pending";
      const updated = await prisma.completionCallback.updateMany({
        where: fenced(row.id, "pending"),
        data: {
          ...release,
          state,
          attempts: attempt,
          lastResponseStatus: result.status,
          nextAttemptAt: state === "pending" ? new Date(at.getTime() + delay!) : null,
          ...(state === "delivered" ? { deliveredAt: at } : {}),
        },
      });
      log({
        level: disposition === "delivered" ? "info" : "warn",
        message: "completion_callback_attempt",
        workspaceId: row.workspaceId,
        operationKind: row.operationKind,
        operationId: row.operationId,
        eventId: row.eventId,
        host: row.urlHost,
        attempt,
        status: result.status,
        durationMs: result.durationMs,
        disposition: state,
        ...(signing.length ? {} : { reason: "signing_secret_missing" }),
        ...(updated.count === 0 ? { leaseLost: true } : {}),
      });
      if (state !== "pending") settled += updated.count;
    }
    return settled;
  }

  return { observe, deliver };
}

/** Resets an operation's delivered or failed callbacks to pending with a fresh
 * attempt budget and the same event IDs. Waiting and pending ones keep going. */
export async function resetCompletionCallbacks(tx: Tx, scope: ActorScope, operation: { kind: OperationKind; id: string }, at: Date) {
  const rows = await tx.completionCallback.findMany({
    where: { workspaceId: scope.workspaceId, operationKind: operation.kind, operationId: operation.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, eventId: true, state: true },
  });
  if (rows.length === 0) {
    throw new ExpectedDomainFailureError({ code: "callback_not_found", kind: "missing", message: "This operation has no completion callback" });
  }
  const reset = rows.filter((row) => row.state === "delivered" || row.state === "failed");
  if (reset.length) {
    await tx.completionCallback.updateMany({
      where: { id: { in: reset.map((row) => row.id) }, state: { in: ["delivered", "failed"] } },
      data: { state: "pending", attempts: 0, nextAttemptAt: at, leaseOwner: null, leaseExpiresAt: null, deliveredAt: null },
    });
  }
  return rows.map((row) => ({ eventId: row.eventId, state: reset.includes(row) ? "pending" : row.state }));
}

let processor: ReturnType<typeof createCompletionCallbackProcessor> | null = null;

/** The worker's production processor, reading Operation Status through the
 * trusted service read. */
export function getCompletionCallbackProcessor() {
  processor ??= createCompletionCallbackProcessor({
    prisma: requiredPrisma(),
    readTrusted: (scope, operation) => operationStatusService.readTrusted(scope, operation),
    leaseOwner: `callbacks:${randomUUID()}`,
  });
  return processor;
}
