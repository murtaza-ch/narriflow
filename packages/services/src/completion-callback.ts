import { readServiceEnvironment } from "./runtime-environment";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ActorScope } from "./actor-scope";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { encodeOperationId, type OperationKind, type OperationStatus, type TrustedOperationStatus } from "./operation-status";
import { OperationIdempotencyConflictError, type IntegrationMutation, type ReceiptCallback } from "./operation-receipt";
import { uuidV5 } from "./uuid-v5";
import { assertPublicHttpUrl } from "./url-policy";

/**
 * Completion Callback: a signed, at-least-once notification delivered to a
 * caller-supplied URL when one accepted operation reaches a terminal
 * Operation Status. Payloads carry IDs only; receivers call the API for files.
 * Signing follows Standard Webhooks (https://www.standardwebhooks.com/).
 */

export const CALLBACK_DELIVERY_TIMEOUT_MS = 10_000;
/** Retries after the first attempt; the row fails after the last one. */
export const CALLBACK_RETRY_DELAYS_MS = [
  30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
] as const;
export const CALLBACK_RETRY_JITTER = 0.2;
const OBSERVATION_FIRST_DELAY_MS = 15_000;
const OBSERVATION_MAX_DELAY_MS = 300_000;
/** After rotation the previous secret keeps signing for this long. */
export const CALLBACK_SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;
const MAX_CALLBACK_URL_LENGTH = 2_048;

export type CallbackState = "waiting" | "pending" | "delivered" | "failed" | "cancelled";

function invalidUrl(reason: string): never {
  throw new ExpectedDomainFailureError({
    code: "callback_url_invalid",
    kind: "invalid",
    message: "Callback URLs must be public HTTPS URLs on port 443",
    details: { reason },
  });
}

/** Structural acceptance only. Each native execution resolves and pins DNS anew. */
export async function assertCompletionCallbackUrl(raw: string): Promise<URL> {
  if (raw.length > MAX_CALLBACK_URL_LENGTH) invalidUrl("too_long");
  let url: URL;
  try {
    url = assertPublicHttpUrl(raw);
  } catch {
    invalidUrl("not_public");
  }
  if (url.protocol !== "https:") invalidUrl("not_https");
  if (url.port !== "") invalidUrl("not_port_443");
  return url;
}

function callbackKey(material: string) {
  if (!material.trim()) throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY is required for Completion Callbacks");
  return Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), "narriflow-completion-callback-v1", 32));
}

/** Seals callback URLs and signing secrets with a purpose-bound key derived
 * from the existing data encryption key material. */
export function createCallbackCipher(material = readServiceEnvironment().SOCIAL_TOKEN_ENCRYPTION_KEY ?? "") {
  const key = callbackKey(material);
  return {
    seal(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
    },
    open(sealed: string) {
      const [version, iv, tag, ciphertext] = sealed.split(":");
      if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported sealed callback value");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

export type CallbackCipher = ReturnType<typeof createCallbackCipher>;

/** What a callback row stores about its URL. The fingerprint compares
 * replayed URLs without decrypting. */
export interface CallbackRegistration {
  encryptedUrl: string;
  urlHost: string;
  urlFingerprint: string;
}

export function callbackUrlFingerprint(url: string) {
  return createHash("sha256").update(url).digest("hex");
}

export function prepareCallbackRegistration(url: URL, cipher: CallbackCipher = createCallbackCipher()): CallbackRegistration {
  const href = url.toString();
  return { encryptedUrl: cipher.seal(href), urlHost: url.host, urlFingerprint: callbackUrlFingerprint(href) };
}

export function generateCallbackSigningSecret() {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

/** Standard Webhooks signature header: one `v1,<base64>` per valid secret. */
export function signCallback(input: { eventId: string; timestamp: number; body: string; secrets: readonly string[] }) {
  return input.secrets
    .map((secret) => {
      const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
      return `v1,${createHmac("sha256", key).update(`${input.eventId}.${input.timestamp}.${input.body}`).digest("base64")}`;
    })
    .join(" ");
}

export interface CallbackPayload {
  id: string;
  type: "operation.completed";
  version: 1;
  createdAt: string;
  workspaceId: string;
  data: {
    operationId: string;
    kind: OperationKind;
    state: "completed" | "partial" | "failed" | "cancelled" | "unavailable";
    projectId: string | null;
    clipIds?: string[];
    exportId?: string;
    notices?: OperationStatus["notices"];
    failureCode?: string;
  };
}

/** Freezes the event for a terminal or unavailable Operation Status, or
 * returns null while the operation is still working. */
export function buildCallbackPayload(input: { eventId: string; workspaceId: string; createdAt: Date; status: TrustedOperationStatus }): CallbackPayload | null {
  const { status } = input;
  if (status.state === "working") return null;
  const base = { id: input.eventId, type: "operation.completed" as const, version: 1 as const, createdAt: input.createdAt.toISOString(), workspaceId: input.workspaceId };
  const operationId = encodeOperationId(status);
  if (status.state === "unavailable") {
    return { ...base, data: { operationId, kind: status.kind, state: "unavailable", projectId: null, failureCode: "project_unavailable" } };
  }
  return {
    ...base,
    data: {
      operationId,
      kind: status.kind,
      state: status.state,
      projectId: status.results.projectId,
      ...(status.results.clipIds.length ? { clipIds: status.results.clipIds } : {}),
      ...(status.results.exportId ? { exportId: status.results.exportId } : {}),
      ...(status.notices.length ? { notices: status.notices } : {}),
      ...(status.failureCode ? { failureCode: status.failureCode } : {}),
    },
  };
}

/** Observation backs off from about 15 seconds to a 5-minute cap. */
export function nextObservationDelayMs(observationCount: number) {
  return Math.min(OBSERVATION_MAX_DELAY_MS, OBSERVATION_FIRST_DELAY_MS * 2 ** Math.max(0, observationCount));
}

/** Delay before the next attempt after `attempts` failed deliveries, or null
 * when the retry budget is spent. */
export function nextAttemptDelayMs(attempts: number, random: () => number = Math.random) {
  const base = CALLBACK_RETRY_DELAYS_MS[attempts - 1];
  if (base === undefined) return null;
  return Math.round(base * (1 - CALLBACK_RETRY_JITTER + 2 * CALLBACK_RETRY_JITTER * random()));
}

export type DeliveryDisposition = "delivered" | "cancelled" | "retry";

export function classifyDelivery(status: number | null): DeliveryDisposition {
  if (status !== null && status >= 200 && status < 300) return "delivered";
  if (status === 410) return "cancelled";
  return "retry";
}

const CALLBACK_EVENT_NAMESPACE = "3b9c5e21-7d4f-5a86-b1c2-9e0f7a6d5c4b";
/** How long a worker owns a delivery row before another may claim it. */
export const CALLBACK_LEASE_MS = 60_000;

export function callbackEventId(acceptanceId: string) {
  return uuidV5(CALLBACK_EVENT_NAMESPACE, acceptanceId);
}

export class CallbackSecretRequiredError extends ExpectedDomainFailureError<"callback_secret_required"> {
  constructor() {
    super({
      code: "callback_secret_required",
      kind: "conflict",
      message: "Create a callback signing secret in Settings → Developer access before using callbacks or webhooks",
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

export function createCallbackSigningSecrets(dependencies: { prisma: PrismaClient; cipher?: CallbackCipher; now?: () => Date }) {
  const prisma = () => dependencies.prisma;
  const cipher = () => dependencies.cipher ?? createCallbackCipher();
  const now = dependencies.now ?? (() => new Date());

  /**
   * Rotates inside the caller's transaction (the Operation Receipt's) and
   * returns the new secret once: it is stored sealed and never shown again.
   * `id` names the stored secret, which is all a receipt may keep of it.
   */
  async function issue(tx: Tx, workspaceId: string) {
    const secret = generateCallbackSigningSecret();
    const at = now();
    // Serialize rotations so a Workspace never has two current secrets.
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
    await tx.callbackSigningSecret.deleteMany({ where: { workspaceId, retiresAt: { lte: at } } });
    await tx.callbackSigningSecret.updateMany({ where: { workspaceId, retiresAt: { gt: at } }, data: { retiresAt: at } });
    await tx.callbackSigningSecret.updateMany({ where: { workspaceId, retiresAt: null }, data: { retiresAt: new Date(at.getTime() + CALLBACK_SECRET_OVERLAP_MS) } });
    const row = await tx.callbackSigningSecret.create({ data: { workspaceId, encryptedSecret: cipher().seal(secret), createdAt: at }, select: { id: true } });
    return { id: row.id, secret, createdAt: at.toISOString() };
  }

  return {
    issue,
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
    /** Rotates in its own transaction. Browser rotation goes through the receipt-backed command instead. */
    async rotate(workspaceId: string) {
      const { secret, createdAt } = await prisma().$transaction((tx) => issue(tx, workspaceId));
      return { secret, createdAt };
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

/** Resets an operation's delivered or failed callbacks to pending with a fresh
 * attempt budget and the same event IDs. Waiting and pending ones keep going. */
export async function resetCompletionCallbacks(tx: Tx, scope: ActorScope, operation: { kind: OperationKind; id: string }, at: Date) {
  const rows = await tx.completionCallback.findMany({
    where: { workspaceId: scope.workspaceId, operationKind: operation.kind, operationId: operation.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, eventId: true, state: true },
  });
  if (rows.length === 0) {
    throw new ExpectedDomainFailureError({ code: "callback_not_found", kind: "missing", message: "This operation has no completion callback. Include callback.url when you start the work to receive one." });
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
