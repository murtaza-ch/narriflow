import type { ExecutionArtifact as ArtifactRow, ExecutionAttempt as AttemptRow, ExecutionDispatch as DispatchRow, Prisma, PrismaClient } from "@prisma/client";
import {
  executionCommandSchema, executionDispositionSchema, executionDeadlineSchema, executorFenceSchema,
  type ExecutionCommand, type ExecutionDispatchReference, type ExecutionDisposition, type ExecutionSubjectKind,
} from "@narriflow/validators/execution";
import type { VerifiedExecutionRequest } from "./execution-signature";
import type { ExecutorArtifactCommit, ExecutorDomainControl, ExecutorMutationContext, ExecutorMutationResult, ExecutorExpiryResult } from "./executor-domain-control";

type Tx = Prisma.TransactionClient;
type Attempt = AttemptRow & { dispatch: DispatchRow };
type FailureCode = "invalid_reference" | "replay_conflict" | "authority_lost" | "artifact_invalid" | "storage_unavailable" | "scheduler_unavailable" | "epoch_unavailable" | "keys_unavailable" | "invalid_audience";
export class ExecutorControlError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = "ExecutorControlError"; }
}

export interface ExecutorLiveAuthority {
  fence: { reference: ExecutionDispatchReference; attemptToken: string; owner: string };
  functionName: string;
  leaseExpiresAt: Date;
  operationDeadlineAt: Date;
  input: { storageKey: string; etag: string; byteLength: bigint; sha256: string } | null;
}

export interface ExecutorArtifactHead {
  etag: string;
  contentType: string;
  byteLength: bigint;
  /** Available for R2 single puts with a verified checksum, absent for multipart objects. */
  sha256?: string;
}

interface Options<TRef, TArtifact extends ExecutorArtifactCommit> {
  database: PrismaClient;
  subjectKind: ExecutionSubjectKind;
  domain: ExecutorDomainControl<TRef, TArtifact>;
  /** Fetch only the server-assigned exact key, without holding domain or SQL locks. */
  artifacts?: {
    head(assignment: Readonly<ArtifactRow>): Promise<ExecutorArtifactHead | null>;
    /** Typed role evidence comes from assigned, immutable storage, never callback-selected keys. */
    prepare(assignment: Readonly<ArtifactRow>, verified: ExecutorArtifactCommit, reported: Extract<ExecutionCommand, { action: "commit-artifact" }>["artifact"]): Promise<TArtifact>;
  };
  /** Server-owned immutable work inputs supply expected render provenance. */
  prepareContext?(attempt: Readonly<AttemptRow>): Promise<ExecutorMutationContext["fingerprints"]>;
  /** Confirmation is attempted after commit and retried with exact inbox replays. */
  deliverWakes?(dispatchIds: readonly string[]): Promise<void>;
}

function referenceOf(command: ExecutionCommand) { return command.action === "acquire" ? command.reference : command.fence.reference; }
function tokenOf(command: ExecutionCommand) { return command.action === "acquire" ? command.attemptToken : command.fence.attemptToken; }
function ownerOf(command: ExecutionCommand) { return command.action === "acquire" ? command.owner : command.fence.owner; }

function assertReference(attempt: Attempt | null, reference: ExecutionDispatchReference, subjectKind: ExecutionSubjectKind): asserts attempt is Attempt {
  if (!attempt || reference.subject.kind !== subjectKind || attempt.dispatchId !== reference.dispatchId ||
    attempt.deploymentEpoch !== reference.deploymentEpoch || attempt.generation !== reference.generation || attempt.inputHash !== reference.inputHash ||
    attempt.dispatch.kind !== reference.kind || attempt.dispatch.subjectKind !== reference.subject.kind || attempt.dispatch.subjectId !== reference.subject.id) {
    throw new ExecutorControlError("invalid_reference");
  }
}

function ended(attempt: AttemptRow): ExecutionDisposition | null {
  switch (attempt.status) {
    case "completed": return { disposition: "completed" };
    case "failed": return { disposition: "failed", failureCode: attempt.failureCode ?? "execution_failed" };
    case "released": return { disposition: "released", dueAt: null };
    case "cancelled": return { disposition: "cancelled" };
    case "expired": return { disposition: "expired" };
    case "superseded": return { disposition: "superseded" };
    default: return null;
  }
}

function assertAssigned(assignment: ArtifactRow | null, attempt: Attempt, command: Extract<ExecutionCommand, { action: "commit-artifact" }>): asserts assignment is ArtifactRow {
  const a = command.artifact;
  const prefix = `execution/${attempt.deploymentEpoch}/${attempt.attemptToken}/${command.fence.owner}/`;
  if (!assignment || assignment.multipartAbortIntentAt || assignment.attemptToken !== attempt.attemptToken || assignment.owner !== command.fence.owner ||
    assignment.role !== a.role || assignment.bindingHash !== a.bindingHash || !assignment.storageKey.startsWith(prefix) ||
    assignment.contentType !== a.contentType || BigInt(a.byteLength) > assignment.maxBytes) throw new ExecutorControlError("artifact_invalid");
}

/** Signed transport and domain authority remain separate; every mutation commits with its inbox disposition. */
export function createExecutorControl<TRef, TArtifact extends ExecutorArtifactCommit = ExecutorArtifactCommit>(options: Options<TRef, TArtifact>) {
  const db = options.database;

  async function priorReceipt(client: Pick<Tx, "executionInboxReceipt">, verified: VerifiedExecutionRequest) {
    const receipt = await client.executionInboxReceipt.findUnique({ where: { audience_deliveryId: {
      audience: verified.metadata.audience, deliveryId: verified.metadata.deliveryId,
    } } });
    if (!receipt) return null;
    if (receipt.requestHash !== verified.requestHash) throw new ExecutorControlError("replay_conflict");
    return { disposition: executionDispositionSchema.parse(receipt.disposition), wakeDispatchIds: receipt.wakeDispatchIds };
  }

  async function finish(result: { disposition: ExecutionDisposition; wakeDispatchIds: readonly string[] }): Promise<ExecutionDisposition> {
    if (result.wakeDispatchIds.length) {
      if (!options.deliverWakes) throw new ExecutorControlError("scheduler_unavailable");
      await options.deliverWakes(result.wakeDispatchIds);
    }
    return result.disposition;
  }

  async function execute(input: { command: unknown; verifiedRequest: VerifiedExecutionRequest }): Promise<ExecutionDisposition> {
    const command = executionCommandSchema.parse(input.command);
    const verified = input.verifiedRequest;
    if (!["executor-control", "dev-device"].includes(verified.metadata.audience)) throw new ExecutorControlError("invalid_audience");
    const previous = await priorReceipt(db, verified);
    if (previous) return finish(previous);
    const reference = referenceOf(command), attemptToken = tokenOf(command), owner = ownerOf(command);
    const initial = await db.executionAttempt.findUnique({ where: { attemptToken }, include: { dispatch: true } });
    assertReference(initial, reference, options.subjectKind);
    const fingerprints = command.action === "process-start" ? await options.prepareContext?.(initial) : undefined;
    let prepared: TArtifact | undefined;
    if (command.action === "commit-artifact") {
      const assignment = await db.executionArtifact.findUnique({ where: { id: command.artifact.artifactId } });
      assertAssigned(assignment, initial, command);
      // A committed object remains a fact after authority expires. Never delete it on a lost acknowledgement.
      if (assignment.committedAt) {
        if (assignment.byteLength !== BigInt(command.artifact.byteLength) || assignment.etag !== command.artifact.etag || assignment.checksumSha256 !== command.artifact.sha256) {
          throw new ExecutorControlError("artifact_invalid");
        }
      } else {
        if (!options.artifacts) throw new ExecutorControlError("storage_unavailable");
        const head = await options.artifacts.head(assignment);
        if (!head || head.etag !== command.artifact.etag || head.contentType !== assignment.contentType ||
          head.byteLength !== BigInt(command.artifact.byteLength) || (head.sha256 !== undefined && head.sha256 !== command.artifact.sha256)) throw new ExecutorControlError("artifact_invalid");
        const artifact: ExecutorArtifactCommit = {
          artifactId: assignment.id, role: command.artifact.role, storageKey: assignment.storageKey, contentType: assignment.contentType,
          byteLength: head.byteLength, sha256: command.artifact.sha256, etag: head.etag, bindingHash: assignment.bindingHash,
        };
        prepared = await options.artifacts.prepare(assignment, artifact, command.artifact);
      }
    }

    const result = await db.$transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      if (!epoch) throw new ExecutorControlError("epoch_unavailable");
      const inboxKey = `executor-inbox:${verified.metadata.audience}:${verified.metadata.deliveryId}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${inboxKey},0)) IS NULL AS "locked"`;
      const replay = await priorReceipt(tx, verified);
      if (replay) return replay;
      const wakeDispatchIds: string[] = [];
      const track = (mutation: ExecutorMutationResult) => { if (mutation) wakeDispatchIds.push(...mutation.dispatchIds); };

      const record = async (value: ExecutionDisposition, now: Date) => {
        const disposition = executionDispositionSchema.parse(value);
        const uniqueWakes = [...new Set(wakeDispatchIds)];
        if (uniqueWakes.length > 128) throw new ExecutorControlError("invalid_reference");
        await tx.executionInboxReceipt.create({ data: { audience: verified.metadata.audience, deliveryId: verified.metadata.deliveryId,
          requestHash: verified.requestHash, keyId: verified.metadata.keyId, disposition: disposition as Prisma.InputJsonValue,
          wakeDispatchIds: uniqueWakes, committedAt: now, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000) } });
        return { disposition, wakeDispatchIds: uniqueWakes };
      };
      if (epoch.epoch !== reference.deploymentEpoch) return record({ disposition: "superseded" }, await clock(tx));
      const locked = await options.domain.lockExecution(tx, reference, attemptToken);
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken"=${attemptToken}::uuid FOR UPDATE`;
      const attempt = await tx.executionAttempt.findUnique({ where: { attemptToken }, include: { dispatch: true } });
      assertReference(attempt, reference, options.subjectKind);
      const now = await clock(tx);
      if (locked.kind === "terminal") return record(locked.disposition, now);
      const terminal = ended(attempt);
      if (terminal) return record(terminal, now);
      if (attempt.revokedAt) return record({ disposition: "superseded" }, now);
      if (attempt.operationDeadlineAt <= now) return record({ disposition: "expired" }, now);
      const requestedLease = command.action === "acquire" || command.action === "renew" ? command.leaseSeconds : 120;
      const leaseExpiresAt = command.action === "acquire" || command.action === "renew"
        ? new Date(Math.min(now.getTime() + requestedLease * 1_000, attempt.operationDeadlineAt.getTime()))
        : attempt.leaseExpiresAt ?? new Date(now.getTime());
      const context: ExecutorMutationContext = { reference, attemptToken, owner, now, leaseExpiresAt, operationDeadlineAt: attempt.operationDeadlineAt,
        functionName: attempt.functionName, ...(fingerprints ? { fingerprints } : {}) };

      if (command.action === "acquire") {
        if (attempt.owner) {
          if (!attempt.leaseExpiresAt || attempt.leaseExpiresAt <= now) return record({ disposition: "expired" }, now);
          return record({ disposition: attempt.owner === owner ? "already_owned" : "busy", leaseExpiresAt: attempt.leaseExpiresAt.toISOString() }, now);
        }
        track(await options.domain.acquireExecution(tx, locked.ref, context));
        await tx.executionAttempt.update({ where: { attemptToken }, data: { owner, leaseExpiresAt } });
        return record({ disposition: "acquired", fence: { reference, attemptToken, owner }, serverTime: now.toISOString(),
          leaseExpiresAt: leaseExpiresAt.toISOString(), operationDeadlineAt: attempt.operationDeadlineAt.toISOString() }, now);
      }

      if (command.action === "commit-artifact") {
        const assignment = await tx.executionArtifact.findUnique({ where: { id: command.artifact.artifactId } });
        assertAssigned(assignment, attempt, command);
        if (assignment.committedAt) {
          if (assignment.byteLength !== BigInt(command.artifact.byteLength) || assignment.etag !== command.artifact.etag || assignment.checksumSha256 !== command.artifact.sha256) throw new ExecutorControlError("artifact_invalid");
          return record({ disposition: "committed", artifactId: assignment.id }, now);
        }
      }
      if (attempt.owner !== owner || !attempt.leaseExpiresAt) throw new ExecutorControlError("authority_lost");
      if (attempt.leaseExpiresAt <= now) return record({ disposition: "expired" }, now);
      if (command.action === "read-disposition") return record(attempt.processStartedAt ? { disposition: "started" } :
        { disposition: "already_owned", leaseExpiresAt: attempt.leaseExpiresAt.toISOString() }, now);

      if (command.action === "process-start") {
        if (!attempt.processStartedAt) {
          track(await options.domain.startExecution(tx, locked.ref, context));
          await tx.executionAttempt.update({ where: { attemptToken }, data: { status: "running", processStartedAt: now } });
        }
        return record({ disposition: "started" }, now);
      }
      if (command.action === "renew") {
        if (!attempt.processStartedAt || attempt.status !== "running") throw new ExecutorControlError("authority_lost");
        track(await options.domain.renewExecution(tx, locked.ref, context));
        await tx.executionAttempt.update({ where: { attemptToken }, data: { leaseExpiresAt } });
        return record({ disposition: "renewed", leaseExpiresAt: leaseExpiresAt.toISOString() }, now);
      }
      if (command.action === "commit-artifact") {
        if (!prepared || !attempt.processStartedAt) throw new ExecutorControlError("artifact_invalid");
        track(await options.domain.commitArtifactExecution(tx, locked.ref, context, prepared));
        await tx.executionArtifact.update({ where: { id: prepared.artifactId }, data: { committedAt: now, byteLength: prepared.byteLength, etag: prepared.etag, checksumSha256: prepared.sha256 } });
        const outcome = await options.domain.lockExecution(tx, reference, attemptToken);
        if (outcome.kind === "terminal") {
          const status = outcome.disposition.disposition;
          await tx.executionAttempt.update({ where: { attemptToken }, data: { status: ["completed", "cancelled", "expired", "superseded"].includes(status) ? status : "failed", finishedAt: now } });
        }
        return record({ disposition: "committed", artifactId: prepared.artifactId }, now);
      }
      if (command.action === "progress") {
        if (!attempt.processStartedAt) throw new ExecutorControlError("authority_lost");
        track(await options.domain.progressExecution(tx, locked.ref, context, command));
        return record({ disposition: "progress_recorded" }, now);
      }
      if (command.action === "fail") {
        track(await options.domain.failExecution(tx, locked.ref, context, command));
        await tx.executionAttempt.update({ where: { attemptToken }, data: { status: "failed", failureCode: command.failureCode, finishedAt: now } });
        return record({ disposition: "failed", failureCode: command.failureCode }, now);
      }
      track(await options.domain.releaseExecution(tx, locked.ref, context, command));
      await tx.executionAttempt.update({ where: { attemptToken }, data: { status: "released", finishedAt: now } });
      return record({ disposition: "released", dueAt: null }, now);
    });
    return finish(result);
  }
  /** Read fresh ownership before preparing a work package or scoped storage
   * grant. The caller rechecks after external I/O and never caches this result. */
  async function withAuthority<T>(fenceInput: unknown, requireStarted: boolean, operation: (tx: Tx, authority: ExecutorLiveAuthority) => Promise<T>): Promise<T> {
    const fence = executorFenceSchema.parse(fenceInput);
    return db.$transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      if (!epoch || epoch.epoch !== fence.reference.deploymentEpoch) throw new ExecutorControlError("authority_lost");
      const locked = await options.domain.lockExecution(tx, fence.reference, fence.attemptToken);
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken"=${fence.attemptToken}::uuid FOR UPDATE`;
      const attempt = await tx.executionAttempt.findUnique({ where: { attemptToken: fence.attemptToken }, include: { dispatch: true } });
      assertReference(attempt, fence.reference, options.subjectKind);
      const now = await clock(tx);
      if (locked.kind === "terminal" || ended(attempt) || attempt.revokedAt || attempt.owner !== fence.owner ||
        !attempt.leaseExpiresAt || attempt.leaseExpiresAt <= now || attempt.operationDeadlineAt <= now ||
        (requireStarted && (!attempt.processStartedAt || attempt.status !== "running"))) throw new ExecutorControlError("authority_lost");
      return operation(tx, { fence, functionName: attempt.functionName, leaseExpiresAt: attempt.leaseExpiresAt, operationDeadlineAt: attempt.operationDeadlineAt,
        input: attempt.inputStorageKey && attempt.inputEtag && attempt.inputByteLength !== null && attempt.inputChecksumSha256
          ? { storageKey: attempt.inputStorageKey, etag: attempt.inputEtag, byteLength: attempt.inputByteLength, sha256: attempt.inputChecksumSha256 } : null });
    });
  }

  async function authorize(fenceInput: unknown, requireStarted = true): Promise<ExecutorLiveAuthority> {
    return withAuthority(fenceInput, requireStarted, async (_tx, authority) => authority);
  }

  /** A scheduler observation can revoke authority, never grant or extend it.
   * Mutating outcomes and their wakes are replayable; a sleep is always re-read. */
  async function expireDeadline(input: { deadline: unknown; deliveryId: string }): Promise<ExecutorExpiryResult> {
    const deadline = executionDeadlineSchema.parse(input.deadline);
    if (!["lease", "operation"].includes(deadline.kind) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.deliveryId)) throw new ExecutorControlError("invalid_reference");
    if (!options.domain.expireExecution) throw new ExecutorControlError("scheduler_unavailable");
    const requestHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(deadline)))), byte => byte.toString(16).padStart(2, "0")).join("");
    const receiptKey = { audience: "watchdog", deliveryId: input.deliveryId };
    const parseOutcome = (value: Prisma.JsonValue): ExecutorExpiryResult => {
      if (!value || typeof value !== "object" || Array.isArray(value) || !["terminal", "superseded", "expired"].includes(String(value.kind))) throw new ExecutorControlError("invalid_reference");
      return { kind: value.kind as "terminal" | "superseded" | "expired" };
    };
    const result = await db.$transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      if (!epoch) throw new ExecutorControlError("epoch_unavailable");
      const inboxKey = `executor-inbox:watchdog:${input.deliveryId}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${inboxKey},0)) IS NULL AS "locked"`;
      const prior = await tx.executionInboxReceipt.findUnique({ where: { audience_deliveryId: receiptKey } });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ExecutorControlError("replay_conflict");
        return { outcome: parseOutcome(prior.disposition), dispatchIds: prior.wakeDispatchIds };
      }
      const record = async (outcome: ExecutorExpiryResult, now: Date) => {
        if (outcome.kind === "sleep") return { outcome, dispatchIds: [] };
        const dispatchIds = [...new Set(outcome.dispatchIds ?? [])];
        if (dispatchIds.length > 128) throw new ExecutorControlError("invalid_reference");
        await tx.executionInboxReceipt.create({ data: { ...receiptKey, requestHash, keyId: "internal-watchdog",
          disposition: { kind: outcome.kind }, wakeDispatchIds: dispatchIds, committedAt: now, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000) } });
        return { outcome, dispatchIds };
      };
      const reference = deadline.reference;
      if (epoch.epoch !== reference.deploymentEpoch) return record({ kind: "superseded" }, await clock(tx));
      const locked = await options.domain.lockExecution(tx, reference, deadline.attemptToken);
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken"=${deadline.attemptToken}::uuid FOR UPDATE`;
      const attempt = await tx.executionAttempt.findUnique({ where: { attemptToken: deadline.attemptToken }, include: { dispatch: true } });
      assertReference(attempt, reference, options.subjectKind);
      const now = await clock(tx);
      if (ended(attempt)) return record({ kind: "terminal" }, now);
      if (locked.kind === "terminal") {
        const status = locked.disposition.disposition;
        await tx.executionAttempt.update({ where: { attemptToken: attempt.attemptToken }, data: {
          status: ["completed", "cancelled", "expired", "superseded"].includes(status) ? status : "failed", finishedAt: now, revokedAt: now,
        } });
        return record({ kind: status === "superseded" ? "superseded" : "terminal" }, now);
      }
      if (deadline.kind === "operation" && new Date(deadline.observedDeadlineAt).getTime() !== attempt.operationDeadlineAt.getTime()) return record({ kind: "superseded" }, now);
      const dueAt = new Date(Math.min(attempt.leaseExpiresAt?.getTime() ?? Infinity, attempt.operationDeadlineAt.getTime()));
      if (dueAt > now) return { outcome: { kind: "sleep" as const, dueAt }, dispatchIds: [] };
      const outcome = await options.domain.expireExecution!(tx, reference, deadline.attemptToken, {
        kind: deadline.kind as "lease" | "operation", observedDeadlineAt: new Date(deadline.observedDeadlineAt),
      });
      if (outcome.kind === "expired") await tx.executionAttempt.update({ where: { attemptToken: attempt.attemptToken }, data: { status: "expired", finishedAt: now, revokedAt: now } });
      return record(outcome, now);
    });
    if (result.dispatchIds.length) {
      if (!options.deliverWakes) throw new ExecutorControlError("scheduler_unavailable");
      await options.deliverWakes(result.dispatchIds);
    }
    return result.outcome.kind === "sleep" ? result.outcome : { kind: result.outcome.kind };
  }
  return { execute, expireDeadline, authorize, withAuthority };
}

async function clock(tx: Tx) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  if (!row) throw new ExecutorControlError("epoch_unavailable");
  return row.now;
}
