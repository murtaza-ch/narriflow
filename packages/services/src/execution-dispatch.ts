import { executionDispatchReferenceSchema, type ExecutionDispatchKind, type ExecutionDispatchReference, type ExecutionSubject } from "@narriflow/validators/execution";
import { Prisma, type PrismaClient, type ExecutionDispatch as DispatchRow } from "@prisma/client";

type Tx = Prisma.TransactionClient;
type QueryClient = Pick<Tx, "$queryRaw">;
export type ExecutionDispatchDatabase = Pick<PrismaClient, "$transaction" | "$queryRaw">;
export type ExecutionDeadlineKind = "lease" | "operation" | "provider_submission" | "provider_result" | "retry";

export type ExecutionDispatchFailureCode = "invalid_dispatch" | "dispatch_conflict" | "epoch_unavailable" | "epoch_superseded" | "scheduler_unavailable" | "confirmation_unknown" | "invalid_confirmation";

export class ExecutionDispatchError extends Error {
  constructor(readonly code: ExecutionDispatchFailureCode) {
    super(code);
    this.name = "ExecutionDispatchError";
  }
}

/** A confirmed persisted retry can become a durable Workflow sleep. It does
 * not acknowledge registration or admit another charged domain attempt. */
export class ExecutionDispatchPendingError extends ExecutionDispatchError {
  readonly retryAt: Date;
  constructor(retryAt: Date) {
    super("scheduler_unavailable");this.name="ExecutionDispatchPendingError";
    if(!validDate(retryAt))throw new ExecutionDispatchError("invalid_dispatch");
    this.retryAt=new Date(retryAt);
  }
}

export interface ExecutionDispatchIdentityInput {
  deploymentEpoch: number;
  kind: ExecutionDispatchKind;
  subject: ExecutionSubject;
  generation: number;
  wakeKind?: string | null;
  deadlineKind?: ExecutionDeadlineKind | null;
  observedDeadlineAt?: Date | null;
}

export interface AppendExecutionDispatchInput extends ExecutionDispatchIdentityInput {
  inputHash: string;
  /** The domain's immutable due time. Registration itself is eligible immediately. */
  dueAt: Date;
}

function validDate(date: unknown): date is Date {
  return date instanceof Date && Number.isFinite(date.getTime());
}

function validateIdentity(input: ExecutionDispatchIdentityInput): void {
  const validation = executionDispatchReferenceSchema.safeParse({
    dispatchId: "00000000-0000-0000-0000-000000000000", deploymentEpoch: input.deploymentEpoch,
    kind: input.kind, subject: input.subject, generation: input.generation, inputHash: "0".repeat(64),
  });
  if (!validation.success || input.generation > 2147483647 || input.deploymentEpoch > 2147483647 ||
    (input.wakeKind != null && !/^[a-z][a-z0-9_.-]{0,39}$/.test(input.wakeKind)) ||
    (input.deadlineKind != null && !["lease", "operation", "provider_submission", "provider_result", "retry"].includes(input.deadlineKind)) ||
    ((input.deadlineKind == null) !== (input.observedDeadlineAt == null)) ||
    (input.observedDeadlineAt != null && !validDate(input.observedDeadlineAt))) {
    throw new ExecutionDispatchError("invalid_dispatch");
  }
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Input hash is excluded deliberately: changed inputs for one identity must conflict. */
export async function executionDispatchIdentity(input: ExecutionDispatchIdentityInput): Promise<{ deliveryKey: string; instanceId: string }> {
  validateIdentity(input);
  const subject = [input.deploymentEpoch, input.kind, input.subject.kind, input.subject.id, input.generation];
  const [instance, delivery] = await Promise.all([
    digest(subject),
    digest([...subject, input.wakeKind ?? null, input.deadlineKind ?? null, input.observedDeadlineAt?.toISOString() ?? null]),
  ]);
  return { deliveryKey: `ed_${delivery}`, instanceId: `nf_${instance}` };
}

export function executionDispatchContinuationId(reference: { dispatchId: string }): string {
  validateId(reference.dispatchId);
  return `nf_dispatch_${reference.dispatchId}`;
}

export interface ExecutionDispatchRecord {
  reference: ExecutionDispatchReference;
  deliveryKey: string;
  instanceId: string;
  dueAt: Date;
  nextDeliveryAt: Date;
  deliveryAttempts: number;
  acknowledgedAt: Date | null;
  destinationId: string | null;
  wakeKind: string | null;
  deadlineKind: ExecutionDeadlineKind | null;
  observedDeadlineAt: Date | null;
  deadLetteredAt: Date | null;
  errorCode: string | null;
}

async function epoch(db: QueryClient, lock = false): Promise<number> {
  const rows = lock
    ? await db.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`
    : await db.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1`;
  if (!rows[0]) throw new ExecutionDispatchError("epoch_unavailable");
  return rows[0].epoch;
}

async function databaseNow(db: QueryClient): Promise<Date> {
  const [row] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  if (!row) throw new ExecutionDispatchError("epoch_unavailable");
  return row.now;
}

async function asRecord(row: DispatchRow): Promise<ExecutionDispatchRecord> {
  const reference = executionDispatchReferenceSchema.parse({
    dispatchId: row.id, deploymentEpoch: row.deploymentEpoch, kind: row.kind,
    subject: { kind: row.subjectKind, id: row.subjectId }, generation: row.generation, inputHash: row.inputHash,
  });
  return {
    reference, deliveryKey: row.deliveryKey,
    instanceId: row.deadlineKind !== null || /^(?:cancel_|stt_)[a-f0-9]{32}$/.test(row.wakeKind ?? "")
      ? executionDispatchContinuationId(reference) : (await executionDispatchIdentity({ ...reference, subject: reference.subject })).instanceId,
    dueAt: row.dueAt, nextDeliveryAt: row.nextDeliveryAt, deliveryAttempts: row.deliveryAttempts,
    acknowledgedAt: row.acknowledgedAt, destinationId: row.destinationId, wakeKind: row.wakeKind,
    deadlineKind: row.deadlineKind as ExecutionDeadlineKind | null, observedDeadlineAt: row.observedDeadlineAt,
    deadLetteredAt: row.deadLetteredAt, errorCode: row.errorCode,
  };
}

function validateId(id: string): void {
  if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
    throw new ExecutionDispatchError("invalid_dispatch");
  }
}

export async function readExecutionDispatch(db: QueryClient, id: string): Promise<ExecutionDispatchRecord | null> {
  validateId(id);
  const [row] = await db.$queryRaw<DispatchRow[]>`SELECT * FROM "ExecutionDispatch" WHERE "id" = ${id}::uuid`;
  return row ? asRecord(row) : null;
}

/** Caller owns the transaction. Domain changes and scheduling intent commit or roll back together. */
export async function appendExecutionDispatch(tx: Tx, input: AppendExecutionDispatchInput): Promise<ExecutionDispatchRecord> {
  if (!validDate(input.dueAt) || typeof input.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(input.inputHash)) {
    throw new ExecutionDispatchError("invalid_dispatch");
  }
  validateIdentity(input);
  const value = {
    ...input, subject: { ...input.subject }, dueAt: new Date(input.dueAt),
    wakeKind: input.wakeKind ?? null, deadlineKind: input.deadlineKind ?? null,
    observedDeadlineAt: input.observedDeadlineAt == null ? null : new Date(input.observedDeadlineAt),
  };
  const identity = await executionDispatchIdentity(value);
  if (await epoch(tx) !== value.deploymentEpoch) throw new ExecutionDispatchError("epoch_superseded");
  const id = crypto.randomUUID();
  const inserted = await tx.$queryRaw<DispatchRow[]>`
    INSERT INTO "ExecutionDispatch" ("id", "kind", "subjectKind", "subjectId", "generation", "deploymentEpoch", "inputHash", "deliveryKey", "dueAt", "nextDeliveryAt", "wakeKind", "deadlineKind", "observedDeadlineAt", "updatedAt")
    VALUES (${id}::uuid, ${value.kind}, ${value.subject.kind}, ${value.subject.id}, ${value.generation}, ${value.deploymentEpoch}, ${value.inputHash}, ${identity.deliveryKey},
      (${value.dueAt}::timestamp), clock_timestamp() AT TIME ZONE 'UTC', ${value.wakeKind}, ${value.deadlineKind},
      (${value.observedDeadlineAt}::timestamp), clock_timestamp() AT TIME ZONE 'UTC')
    ON CONFLICT ("deliveryKey") DO NOTHING RETURNING *
  `;
  const existing = inserted[0] ?? (await tx.$queryRaw<DispatchRow[]>`SELECT * FROM "ExecutionDispatch" WHERE "deliveryKey" = ${identity.deliveryKey}`)[0];
  if (!existing) throw new ExecutionDispatchError("dispatch_conflict");
  if (existing.kind !== value.kind || existing.subjectKind !== value.subject.kind || existing.subjectId !== value.subject.id ||
    existing.generation !== value.generation || existing.deploymentEpoch !== value.deploymentEpoch || existing.inputHash !== value.inputHash ||
    existing.dueAt.getTime() !== value.dueAt.getTime() || existing.wakeKind !== value.wakeKind || existing.deadlineKind !== value.deadlineKind ||
    (existing.observedDeadlineAt?.getTime() ?? null) !== (value.observedDeadlineAt?.getTime() ?? null)) {
    throw new ExecutionDispatchError("dispatch_conflict");
  }
  return asRecord(existing);
}

/** Bounded fan-out has the same immutable identity checks as a single append,
 * with one epoch read, one INSERT and one exact-key read for the whole page. */
export async function appendExecutionDispatches(tx: Tx, inputs: readonly AppendExecutionDispatchInput[]): Promise<ExecutionDispatchRecord[]> {
  if (inputs.length > 128) throw new ExecutionDispatchError("invalid_dispatch");
  if (!inputs.length) return [];
  const values = await Promise.all(inputs.map(async input => {
    if (!validDate(input.dueAt) || !/^[a-f0-9]{64}$/.test(input.inputHash)) throw new ExecutionDispatchError("invalid_dispatch");
    validateIdentity(input);
    const value = { ...input, subject: { ...input.subject }, dueAt: new Date(input.dueAt), wakeKind: input.wakeKind ?? null, deadlineKind: input.deadlineKind ?? null,
      observedDeadlineAt: input.observedDeadlineAt ? new Date(input.observedDeadlineAt) : null };
    return { ...value, identity: await executionDispatchIdentity(value) };
  }));
  const currentEpoch = await epoch(tx);
  if (values.some(value => value.deploymentEpoch !== currentEpoch)) throw new ExecutionDispatchError("epoch_superseded");
  const rows = values.map(value => Prisma.sql`(${crypto.randomUUID()}::uuid, ${value.kind}, ${value.subject.kind}, ${value.subject.id}, ${value.generation}, ${value.deploymentEpoch},
    ${value.inputHash}, ${value.identity.deliveryKey}, (${value.dueAt}::timestamp), clock_timestamp() AT TIME ZONE 'UTC', ${value.wakeKind}, ${value.deadlineKind},
    (${value.observedDeadlineAt}::timestamp), clock_timestamp() AT TIME ZONE 'UTC')`);
  await tx.$executeRaw(Prisma.sql`INSERT INTO "ExecutionDispatch" ("id", "kind", "subjectKind", "subjectId", "generation", "deploymentEpoch", "inputHash", "deliveryKey", "dueAt", "nextDeliveryAt", "wakeKind", "deadlineKind", "observedDeadlineAt", "updatedAt")
    VALUES ${Prisma.join(rows)} ON CONFLICT ("deliveryKey") DO NOTHING`);
  const existing = await tx.$queryRaw<DispatchRow[]>(Prisma.sql`SELECT * FROM "ExecutionDispatch" WHERE "deliveryKey" IN (${Prisma.join(values.map(value => value.identity.deliveryKey))})`);
  const byKey = new Map(existing.map(row => [row.deliveryKey, row]));
  return Promise.all(values.map(value => {
    const row = byKey.get(value.identity.deliveryKey);
    if (!row || row.kind !== value.kind || row.subjectKind !== value.subject.kind || row.subjectId !== value.subject.id || row.generation !== value.generation ||
      row.deploymentEpoch !== value.deploymentEpoch || row.inputHash !== value.inputHash || row.dueAt.getTime() !== value.dueAt.getTime() || row.wakeKind !== value.wakeKind ||
      row.deadlineKind !== value.deadlineKind || (row.observedDeadlineAt?.getTime() ?? null) !== (value.observedDeadlineAt?.getTime() ?? null)) throw new ExecutionDispatchError("dispatch_conflict");
    return asRecord(row);
  }));
}

export interface ExecutionDispatchDelivery {
  reference: ExecutionDispatchReference;
  deliveryKey: string;
  instanceId: string;
  dueAt: Date;
  mode: "registration" | "wake";
  wakeKind: string | null;
  deadlineKind: ExecutionDeadlineKind | null;
  observedDeadlineAt: Date | null;
}

export type ExecutionDispatchConfirmation = {
  status: "confirmed_created" | "confirmed_existing" | "confirmed_notified";
  destinationId: string;
};

export interface ExecutionDispatchScheduler {
  /** Existing-instance confirmation acknowledges registration only, never a wake. */
  deliver(delivery: ExecutionDispatchDelivery): Promise<ExecutionDispatchConfirmation>;
}

export type ExecutionDispatchDeliveryResult =
  | { status: "acknowledged"; dispatchId: string; destinationId: string }
  | { status: "pending"; dispatchId: string; reason: "leased" | "not_due" | "delivery_failed" | "lease_lost"; retryAt: Date }
  | { status: "superseded"; dispatchId: string }
  | { status: "dead_lettered"; dispatchId: string; errorCode: string | null }
  | { status: "missing"; dispatchId: string }
  | { status: "unavailable"; dispatchId: string };

export type ExecutionDispatchAcceptance<T> =
  | { accepted: true; receipt: T }
  | { accepted: false; receipt: T; retryable: true; code: "scheduler_registration_pending"; retryAfterSeconds: 1 };

export interface ExecutionDispatchOptions {
  deliveryLeaseMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxDeliveryAttempts?: number;
  concurrency?: number;
}

interface Settings {
  deliveryLeaseMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxDeliveryAttempts: number;
  concurrency: number;
}

function settings(options: ExecutionDispatchOptions): Settings {
  const value: Settings = { deliveryLeaseMs: 30_000, retryBaseMs: 1_000, retryMaxMs: 15 * 60_000, maxDeliveryAttempts: 20, concurrency: 4, ...options };
  for (const [name, max] of [["deliveryLeaseMs", 120_000], ["retryBaseMs", 60_000], ["retryMaxMs", 24 * 60 * 60_000], ["maxDeliveryAttempts", 100], ["concurrency", 8]] as const) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 1 || value[name] > max) throw new ExecutionDispatchError("invalid_dispatch");
  }
  if (value.retryMaxMs < value.retryBaseMs) throw new ExecutionDispatchError("invalid_dispatch");
  return value;
}

function terminal(row: DispatchRow, currentEpoch: number): ExecutionDispatchDeliveryResult | null {
  if (row.deploymentEpoch !== currentEpoch) return { status: "superseded", dispatchId: row.id };
  if (row.acknowledgedAt && row.destinationId) return { status: "acknowledged", dispatchId: row.id, destinationId: row.destinationId };
  if (row.deadLetteredAt) return { status: "dead_lettered", dispatchId: row.id, errorCode: row.errorCode };
  return null;
}

async function locked(db: QueryClient, id: string): Promise<DispatchRow | undefined> {
  return (await db.$queryRaw<DispatchRow[]>`SELECT * FROM "ExecutionDispatch" WHERE "id" = ${id}::uuid FOR UPDATE`)[0];
}

async function boundedMap<T, R>(items: readonly T[], concurrency: number, action: (item: T) => Promise<R>): Promise<R[]> {
  let cursor = 0;
  const results: R[] = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await action(items[index]!);
    }
  }));
  return results;
}

export function createExecutionDispatch(input: {
  database: ExecutionDispatchDatabase;
  scheduler: ExecutionDispatchScheduler;
  options?: ExecutionDispatchOptions;
}) {
  const { database, scheduler } = input;
  const config = settings(input.options ?? {});

  async function claim(id: string): Promise<{ row: DispatchRow; token: string } | ExecutionDispatchDeliveryResult> {
    return database.$transaction(async (tx) => {
      const currentEpoch = await epoch(tx, true);
      const row = await locked(tx, id);
      if (!row) return { status: "missing", dispatchId: id };
      const settled = terminal(row, currentEpoch);
      if (settled) return settled;
      const now = await databaseNow(tx);
      if (row.deliveryLeaseExpiresAt && row.deliveryLeaseExpiresAt > now) {
        return { status: "pending", dispatchId: id, reason: "leased", retryAt: row.deliveryLeaseExpiresAt };
      }
      if (row.nextDeliveryAt > now) return { status: "pending", dispatchId: id, reason: "not_due", retryAt: row.nextDeliveryAt };
      if (row.deliveryAttempts >= config.maxDeliveryAttempts) {
        await tx.$executeRaw`UPDATE "ExecutionDispatch" SET "deadLetteredAt" = clock_timestamp() AT TIME ZONE 'UTC', "errorCode" = 'delivery_attempt_limit', "deliveryToken" = NULL, "deliveryLeaseExpiresAt" = NULL, "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "id" = ${id}::uuid`;
        return { status: "dead_lettered", dispatchId: id, errorCode: "delivery_attempt_limit" };
      }
      const token = crypto.randomUUID();
      const [claimed] = await tx.$queryRaw<DispatchRow[]>`
        WITH timing AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now")
        UPDATE "ExecutionDispatch" SET "deliveryToken" = ${token}::uuid,
          "deliveryLeaseExpiresAt" = timing."now" + (${config.deliveryLeaseMs} * interval '1 millisecond'),
          "nextDeliveryAt" = timing."now" + (${config.deliveryLeaseMs} * interval '1 millisecond'),
          "deliveryAttempts" = "deliveryAttempts" + 1, "updatedAt" = timing."now"
        FROM timing WHERE "id" = ${id}::uuid RETURNING "ExecutionDispatch".*
      `;
      if (!claimed) throw new ExecutionDispatchError("dispatch_conflict");
      return { row: claimed, token };
    });
  }

  async function settle(claimed: { row: DispatchRow; token: string }, confirmation: ExecutionDispatchConfirmation | null, errorCode: ExecutionDispatchFailureCode): Promise<ExecutionDispatchDeliveryResult> {
    const id = claimed.row.id;
    return database.$transaction(async (tx) => {
      const currentEpoch = await epoch(tx, true);
      const row = await locked(tx, id);
      if (!row) return { status: "missing", dispatchId: id };
      const settled = terminal(row, currentEpoch);
      if (settled) return settled;
      const now = await databaseNow(tx);
      if (row.deliveryToken !== claimed.token || !row.deliveryLeaseExpiresAt || row.deliveryLeaseExpiresAt <= now) {
        return { status: "pending", dispatchId: id, reason: "lease_lost", retryAt: row.deliveryLeaseExpiresAt ?? row.nextDeliveryAt };
      }
      if (confirmation) {
        const updated = await tx.$executeRaw`
          UPDATE "ExecutionDispatch" SET "acknowledgedAt" = clock_timestamp() AT TIME ZONE 'UTC', "destinationId" = ${confirmation.destinationId},
            "deliveryToken" = NULL, "deliveryLeaseExpiresAt" = NULL, "errorCode" = NULL, "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE "id" = ${id}::uuid AND "deliveryToken" = ${claimed.token}::uuid AND "deliveryLeaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        `;
        return updated ? { status: "acknowledged", dispatchId: id, destinationId: confirmation.destinationId }
          : { status: "pending", dispatchId: id, reason: "lease_lost", retryAt: row.deliveryLeaseExpiresAt };
      }
      const delay = Math.min(config.retryBaseMs * 2 ** Math.min(row.deliveryAttempts - 1, 20), config.retryMaxMs);
      const [deferred] = await tx.$queryRaw<DispatchRow[]>`
        UPDATE "ExecutionDispatch" SET "deliveryToken" = NULL, "deliveryLeaseExpiresAt" = NULL, "errorCode" = ${errorCode},
          "nextDeliveryAt" = (clock_timestamp() AT TIME ZONE 'UTC') + (${delay} * interval '1 millisecond'),
          "deadLetteredAt" = CASE WHEN "deliveryAttempts" >= ${config.maxDeliveryAttempts} THEN clock_timestamp() AT TIME ZONE 'UTC' ELSE NULL END,
          "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
        WHERE "id" = ${id}::uuid AND "deliveryToken" = ${claimed.token}::uuid AND "deliveryLeaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') RETURNING *
      `;
      if (!deferred) return { status: "pending", dispatchId: id, reason: "lease_lost", retryAt: row.deliveryLeaseExpiresAt };
      return deferred.deadLetteredAt ? { status: "dead_lettered", dispatchId: id, errorCode: deferred.errorCode }
        : { status: "pending", dispatchId: id, reason: "delivery_failed", retryAt: deferred.nextDeliveryAt };
    });
  }

  async function deliver(id: string): Promise<ExecutionDispatchDeliveryResult> {
    validateId(id);
    const claimed = await claim(id);
    if ("status" in claimed) return claimed;
    const record = await asRecord(claimed.row);
    const delivery: ExecutionDispatchDelivery = {
      reference: record.reference, deliveryKey: record.deliveryKey, instanceId: record.instanceId, dueAt: record.dueAt,
      mode: record.wakeKind === null ? "registration" : "wake", wakeKind: record.wakeKind,
      deadlineKind: record.deadlineKind, observedDeadlineAt: record.observedDeadlineAt,
    };
    let confirmation: ExecutionDispatchConfirmation;
    try {
      confirmation = await scheduler.deliver(delivery);
      const validStatus = delivery.mode === "wake" ? confirmation?.status === "confirmed_notified"
        : confirmation?.status === "confirmed_created" || confirmation?.status === "confirmed_existing";
      const validDestination = typeof confirmation?.destinationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(confirmation.destinationId);
      const workflow = ["import_pipeline", "render_run", "operation_driver", "maintenance"].includes(record.reference.kind);
      if (!validStatus || !validDestination || (workflow && delivery.mode === "registration" && confirmation.destinationId !== delivery.instanceId)) {
        throw new ExecutionDispatchError("invalid_confirmation");
      }
    } catch (error) {
      return settle(claimed, null, error instanceof ExecutionDispatchError ? error.code : "scheduler_unavailable");
    }
    return settle(claimed, confirmation, "confirmation_unknown");
  }

  async function confirmAccepted<T>(ids: readonly string[], receipt: T): Promise<ExecutionDispatchAcceptance<T>> {
    if (ids.length > 100) throw new ExecutionDispatchError("invalid_dispatch");
    const results = await boundedMap([...new Set(ids)], config.concurrency,
      async (id) => { try { return await deliver(id); } catch { return { status: "unavailable", dispatchId: id } as const; } });
    return results.every((result) => result.status === "acknowledged") ? { accepted: true, receipt }
      : { accepted: false, receipt, retryable: true, code: "scheduler_registration_pending", retryAfterSeconds: 1 };
  }

  /** Called by the hourly safety Workflow, never installed as a polling loop. */
  async function reconcile(options: { limit?: number } = {}) {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ExecutionDispatchError("invalid_dispatch");
    const currentEpoch = await epoch(database);
    // Bind one DB clock observation so the due bound is an index condition.
    // Active claims also set nextDeliveryAt to their lease expiry.
    const now = await databaseNow(database);
    const rows = await database.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ExecutionDispatch"
      WHERE "deploymentEpoch" = ${currentEpoch} AND "acknowledgedAt" IS NULL AND "deadLetteredAt" IS NULL
        AND "nextDeliveryAt" <= (${now}::timestamp)
        AND ("deliveryLeaseExpiresAt" IS NULL OR "deliveryLeaseExpiresAt" <= (${now}::timestamp))
      ORDER BY "nextDeliveryAt", "id" LIMIT ${limit}
    `;
    const results = await boundedMap(rows, config.concurrency,
      async ({ id }) => { try { return await deliver(id); } catch { return { status: "unavailable", dispatchId: id } as const; } });
    return { inspected: rows.length, acknowledged: results.filter((result) => result.status === "acknowledged").length, results };
  }

  return { deliver, confirmAccepted, reconcile, read: (id: string) => readExecutionDispatch(database, id) };
}

export type ExecutionDispatchService = ReturnType<typeof createExecutionDispatch>;
