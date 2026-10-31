import { createHash, randomUUID } from "node:crypto";
import { readExecutionAdmission, assertExecutionAdmissionOpen } from "./execution-admission";
import { Prisma, type OutboundProbe, type PrismaClient } from "@prisma/client";
import { MAX_RSS_RESULT_BYTES, outboundRssInputSchema, rssFeedSnapshotSchema, type OutboundRssInput } from "@narriflow/validators/outbound-probe";
import type { ExecutionDeadline, ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import type { ActorScope } from "./actor-scope";
import { roleHasWorkspaceCapability, workspaceAllowsCapability } from "@narriflow/validators";
import { assertPublicHttpUrl } from "./url-policy";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import type { ExecutorArtifactCommit, ExecutorDomainControl, ExecutorMutationContext, ExecutorMutationResult, ExecutorExpiryObservation, ExecutorExpiryResult } from "./executor-domain-control";

type Tx = Prisma.TransactionClient;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deadlineMs = 10 * 60_000;
export function outboundProbeExecutionInputHash(row:Pick<OutboundProbe,"id"|"deploymentEpoch"|"requestFingerprint">) {return digest(["outbound-probe-v1",row.id,row.deploymentEpoch,row.requestFingerprint]);}
export class OutboundProbeError extends ExpectedDomainFailureError {
  constructor(code: "outbound_probe_unavailable" | "outbound_probe_missing" | "outbound_probe_conflict" | "outbound_probe_object_invalid", details?: { jobId?: string }) {
    super({ code, kind: code === "outbound_probe_missing" ? "missing" : code === "outbound_probe_conflict" ? "conflict" : code === "outbound_probe_object_invalid" ? "unprocessable" : "unavailable", message: "The RSS feed check is unavailable", details });
  }
}
export interface OutboundProbeDependencies {
  register(ids: readonly string[]): Promise<void>;
  readResult(artifact: ExecutorArtifactCommit, maxBytes: number): Promise<unknown>;
}
export interface OutboundProbeReference { id: string; attemptToken: string; generation: number; deploymentEpoch: number }
export type OutboundProbeCommit = ExecutorArtifactCommit;
export type OutboundProbePreparation =
  | { kind: "terminal" | "superseded" }
  | { kind: "sleep"; dueAt: Date }
  | { kind: "waiting"; deadline: ExecutionDeadline; deliveryId: string; dispatchIds: readonly string[] };

async function now(tx: Tx) {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  if (!clock) throw new OutboundProbeError("outbound_probe_unavailable");
  return clock.now;
}

function publicJob(row: OutboundProbe) {
  return { jobId: row.id, status: row.status === "completed" ? "ready" as const : row.status === "failed" || row.status === "cancelled" ? "failed" as const : "pending" as const,
    errorCode: row.errorCode };
}

/** Only a frozen, admitted RSS request can run; no caller-selected URL is accepted by the executor boundary. */
export class OutboundProbeService implements ExecutorDomainControl<OutboundProbeReference, OutboundProbeCommit> {
  constructor(private readonly database: PrismaClient, private readonly dependencies: OutboundProbeDependencies) {}

  private async actor(tx: Tx, scope: ActorScope) {
    const workspace = await tx.workspace.findUnique({ where: { id: scope.workspaceId } });
    const membership = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: scope.workspaceId, userId: scope.actorUserId } } });
    const user = await tx.user.findUnique({ where: { id: scope.actorUserId }, select: { deletedAt: true } });
    const role = workspace?.ownerUserId === scope.actorUserId ? "owner" : membership?.role;
    if (!workspace || !user || user.deletedAt || !role || !roleHasWorkspaceCapability(role, "processing.consume") || !workspaceAllowsCapability({role, status: workspace.status}, "processing.consume")) throw new OutboundProbeError("outbound_probe_missing");
  }

  async admit(scope: ActorScope, raw: OutboundRssInput, requestKey?: string) {
    const input = outboundRssInputSchema.parse(raw);
    input.url = assertPublicHttpUrl(input.url).href;
    // Explicit callers may bind a maintenance occurrence. Interactive previews
    // share one immutable result for fifteen minutes; SQL remains authoritative.
    if (requestKey && requestKey.length > 256) throw new OutboundProbeError("outbound_probe_conflict");
    const admitted = await this.database.$transaction(async tx => {
      const epoch = await readExecutionAdmission(tx);
      await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${scope.workspaceId}::uuid FOR SHARE`;
      await this.actor(tx, scope);
      if (!epoch) throw new OutboundProbeError("outbound_probe_unavailable");
      const clock = await now(tx);
      const key = requestKey ?? String(Math.floor(clock.getTime() / (15 * 60_000)));
      const requestFingerprint = digest([input, key, epoch.epoch]);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`outbound-probe:${scope.workspaceId}:${scope.actorUserId}:${requestFingerprint}`},0)) IS NULL AS "locked"`;
      const known = await tx.outboundProbe.findUnique({ where: { workspaceId_createdByUserId_requestFingerprint: { workspaceId: scope.workspaceId, createdByUserId: scope.actorUserId, requestFingerprint } } });
      if (known) return { row: known, ids: await this.registerJob(tx, known) };
      assertExecutionAdmissionOpen(epoch);
      const id = randomUUID();
      const row = await tx.outboundProbe.create({ data: { id, workspaceId: scope.workspaceId, createdByUserId: scope.actorUserId, kind: "rss_feed",
        requestFingerprint, input: input as Prisma.InputJsonValue, inputHash: outboundProbeExecutionInputHash({id,deploymentEpoch:epoch.epoch,requestFingerprint}),
        deploymentEpoch: epoch.epoch, createdAt: clock, operationDeadlineAt: new Date(clock.getTime() + deadlineMs) } });
      return { row, ids: await this.registerJob(tx, row) };
    });
    await this.confirm(admitted.row.id, admitted.ids);
    return publicJob(admitted.row);
  }

  async get(scope: ActorScope, id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new OutboundProbeError("outbound_probe_missing");
    await this.database.$transaction(tx => this.actor(tx, scope));
    const row = await this.database.outboundProbe.findFirst({ where: { id, workspaceId: scope.workspaceId, createdByUserId: scope.actorUserId } });
    if (!row) throw new OutboundProbeError("outbound_probe_missing");
    const job = publicJob(row);
    if (job.status !== "ready") return { ...job, result: null };
    const artifact = await this.database.executionArtifact.findFirst({ where: { id: row.resultArtifactId!, attemptToken: row.attemptToken!, committedAt: { not: null },
      storageKey: row.resultStorageKey!, etag: row.resultEtag!, checksumSha256: row.resultSha256!, byteLength: row.resultByteLength! } });
    if (!artifact || !artifact.byteLength || !artifact.checksumSha256 || !artifact.etag) throw new OutboundProbeError("outbound_probe_object_invalid");
    let raw: unknown;
    try { raw = await this.dependencies.readResult({ artifactId: artifact.id, role: artifact.role as "outbound_receipt", storageKey: artifact.storageKey,
      contentType: artifact.contentType, byteLength: artifact.byteLength, sha256: artifact.checksumSha256, etag: artifact.etag, bindingHash: artifact.bindingHash }, MAX_RSS_RESULT_BYTES); }
    catch { throw new OutboundProbeError("outbound_probe_unavailable", { jobId: id }); }
    const parsed = rssFeedSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new OutboundProbeError("outbound_probe_object_invalid");
    return { ...job, result: parsed.data };
  }

  async workInput(id: string) {
    const job = await this.database.outboundProbe.findUnique({ where: { id } });
    if (!job) throw new OutboundProbeError("outbound_probe_missing");
    return { functionName: "outbound_delivery" as const, inputHash: job.inputHash, command: outboundRssInputSchema.parse(job.input),
      outputs: [{ role: "outbound_receipt" as const, contentType: "application/json", maxBytes: MAX_RSS_RESULT_BYTES, bindingHash: job.inputHash }] };
  }

  /** The Workflow prepares one admitted subject; it never scans or owns a lease. */
  async prepareExecution(reference: ExecutionDispatchReference): Promise<OutboundProbePreparation> {
    return this.database.$transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      if (reference.kind !== "operation_driver" || reference.subject.kind !== "outbound_probe" || epoch?.epoch !== reference.deploymentEpoch) return { kind: "superseded" };
      const registered = await readExecutionDispatch(tx, reference.dispatchId);
      const ledger = registered?.reference;
      if (!ledger || ledger.kind !== reference.kind || ledger.subject.kind !== reference.subject.kind || ledger.subject.id !== reference.subject.id || ledger.generation !== reference.generation || ledger.deploymentEpoch !== reference.deploymentEpoch || ledger.inputHash !== reference.inputHash) return { kind: "superseded" };
      const initial = await tx.outboundProbe.findUnique({ where: { id: reference.subject.id } });
      if (!initial) return { kind: "superseded" };
      await this.lockOwner(tx, initial);
      await tx.$queryRaw`SELECT "id" FROM "OutboundProbe" WHERE "id"=${initial.id}::uuid FOR UPDATE`;
      const job = await tx.outboundProbe.findUniqueOrThrow({ where: { id: initial.id } }); const clock = await now(tx);
      if (job.deploymentEpoch !== epoch.epoch || job.generation !== reference.generation || job.inputHash !== reference.inputHash) return { kind: "superseded" };
      if (["completed", "failed", "cancelled"].includes(job.status)) return { kind: "terminal" };
      if (job.retryAt && job.retryAt > clock) return { kind: "sleep", dueAt: job.retryAt };
      if (job.operationDeadlineAt <= clock) { await this.finishFailure(tx, job, clock, "outbound_delivery_deadline", false); return { kind: "terminal" }; }
      const token = job.attemptToken ?? randomUUID();
      const dispatch = await appendExecutionDispatch(tx, { deploymentEpoch: job.deploymentEpoch, generation: job.generation, kind: "modal_execution",
        subject: { kind: "outbound_probe", id: job.id }, inputHash: job.inputHash, dueAt: job.retryAt ?? job.createdAt });
      await tx.executionAttempt.upsert({ where: { attemptToken: token }, create: { attemptToken: token, dispatchId: dispatch.reference.dispatchId,
        deploymentEpoch: job.deploymentEpoch, generation: job.generation, inputHash: job.inputHash, functionName: "outbound_delivery", operationDeadlineAt: job.operationDeadlineAt }, update: {} });
      if (!job.attemptToken) await tx.outboundProbe.update({ where: { id: job.id }, data: { attemptToken: token } });
      const until = job.leaseExpiresAt ?? job.operationDeadlineAt;
      const deadline = { reference: dispatch.reference, attemptToken: token, kind: job.leaseExpiresAt ? "lease" as const : "operation" as const, observedDeadlineAt: until.toISOString() };
      const watchdog = await appendExecutionDispatch(tx, { deploymentEpoch: job.deploymentEpoch, generation: job.generation, kind: "operation_driver",
        subject: { kind: "outbound_probe", id: job.id }, inputHash: job.inputHash, dueAt: until, deadlineKind: deadline.kind, observedDeadlineAt: until });
      return { kind: "waiting", deadline, deliveryId: watchdog.reference.dispatchId, dispatchIds: [watchdog.reference.dispatchId, dispatch.reference.dispatchId] };
    });
  }

  private async lockOwner(tx: Tx, job: OutboundProbe) {
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${job.workspaceId}::uuid FOR SHARE`;
  }

  async lockExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string) {
    const initial = await tx.outboundProbe.findUnique({ where: { id: reference.subject.id } });
    if (!initial || reference.subject.kind !== "outbound_probe" || reference.kind !== "modal_execution") return { kind: "terminal" as const, disposition: { disposition: "superseded" as const } };
    await this.lockOwner(tx, initial);
    await tx.$queryRaw`SELECT "id" FROM "OutboundProbe" WHERE "id"=${initial.id}::uuid FOR UPDATE`;
    const job = await tx.outboundProbe.findUniqueOrThrow({ where: { id: initial.id } });
    if (job.deploymentEpoch !== reference.deploymentEpoch || job.generation !== reference.generation || job.inputHash !== reference.inputHash || job.attemptToken !== attemptToken) return { kind: "terminal" as const, disposition: { disposition: "superseded" as const } };
    if (job.status === "completed") return { kind: "terminal" as const, disposition: { disposition: "completed" as const } };
    if (job.status === "cancelled") return { kind: "terminal" as const, disposition: { disposition: "cancelled" as const } };
    if (job.status === "failed") return { kind: "terminal" as const, disposition: { disposition: "failed" as const, failureCode: job.errorCode ?? "outbound_delivery_failed" } };
    try { await this.actor(tx, { actorUserId: job.createdByUserId, workspaceId: job.workspaceId }); }
    catch {
      await tx.outboundProbe.update({ where: { id: job.id }, data: { status: "cancelled", completedAt: await now(tx), executorOwner: null, leaseExpiresAt: null } });
      return { kind: "terminal" as const, disposition: { disposition: "cancelled" as const } };
    }
    return { kind: "current" as const, ref: { id: job.id, attemptToken, generation: job.generation, deploymentEpoch: job.deploymentEpoch } };
  }

  private async owned(tx: Tx, ref: OutboundProbeReference, context: ExecutorMutationContext) {
    const clock = await now(tx);
    const job = await tx.outboundProbe.findFirst({ where: { id: ref.id, status: "processing", attemptToken: context.attemptToken, executorOwner: context.owner,
      generation: context.reference.generation, deploymentEpoch: context.reference.deploymentEpoch, leaseExpiresAt: { gt: clock }, operationDeadlineAt: { gt: clock } } });
    if (!job || ref.attemptToken !== context.attemptToken) throw new OutboundProbeError("outbound_probe_conflict");
    return { job, clock };
  }

  async acquireExecution(tx: Tx, ref: OutboundProbeReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const clock = await now(tx);
    const job = await tx.outboundProbe.findUniqueOrThrow({ where: { id: ref.id } });
    if (job.status !== "queued" || job.executorOwner || job.attemptToken !== context.attemptToken || job.chargedAttempts >= job.maxAttempts || job.operationDeadlineAt <= clock ||
      (job.retryAt && job.retryAt > clock) || job.operationDeadlineAt.getTime() !== context.operationDeadlineAt.getTime()) throw new OutboundProbeError("outbound_probe_conflict");
    await tx.outboundProbe.update({ where: { id: job.id }, data: { status: "processing", executorOwner: context.owner, leaseExpiresAt: context.leaseExpiresAt, errorCode: null } });
    return this.wake(tx, job, clock, "outbound_acquired", context.leaseExpiresAt);
  }
  async renewExecution(tx: Tx, ref: OutboundProbeReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    await this.owned(tx, ref, context);
    await tx.outboundProbe.update({ where: { id: ref.id }, data: { leaseExpiresAt: context.leaseExpiresAt } });
    return undefined;
  }
  async startExecution(tx: Tx, ref: OutboundProbeReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const { job } = await this.owned(tx, ref, context);
    if (job.chargedAttempts >= job.maxAttempts) throw new OutboundProbeError("outbound_probe_conflict");
    await tx.outboundProbe.update({ where: { id: ref.id }, data: { chargedAttempts: { increment: 1 } } });
    return undefined;
  }
  async progressExecution(tx: Tx, ref: OutboundProbeReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> { await this.owned(tx, ref, context); return undefined; }

  async commitArtifactExecution(tx: Tx, ref: OutboundProbeReference, context: ExecutorMutationContext, artifact: OutboundProbeCommit): Promise<ExecutorMutationResult> {
    const { job, clock } = await this.owned(tx, ref, context);
    if (artifact.bindingHash !== job.inputHash || artifact.role !== "outbound_receipt" || artifact.contentType !== "application/json" || artifact.byteLength < 1n || artifact.byteLength > BigInt(MAX_RSS_RESULT_BYTES)) throw new OutboundProbeError("outbound_probe_object_invalid");
    await tx.outboundProbe.update({ where: { id: job.id }, data: { status: "completed", completedAt: clock, executorOwner: null, leaseExpiresAt: null, errorCode: null,
      resultArtifactId: artifact.artifactId, resultStorageKey: artifact.storageKey, resultEtag: artifact.etag, resultSha256: artifact.sha256, resultByteLength: artifact.byteLength } });
    return this.wake(tx, job, clock, "outbound_ready");
  }

  private async wake(tx: Tx, job: OutboundProbe, clock: Date, wakeKind: string, lease?: Date) {
    const dispatch = await appendExecutionDispatch(tx, { deploymentEpoch: job.deploymentEpoch, generation: job.generation, kind: "operation_driver", subject: { kind: "outbound_probe", id: job.id },
      inputHash: job.inputHash, dueAt: clock, wakeKind, ...(lease ? { deadlineKind: "lease" as const, observedDeadlineAt: lease } : {}) });
    return { dispatchIds: [dispatch.reference.dispatchId] };
  }

  private async finishFailure(tx: Tx, job: OutboundProbe, clock: Date, errorCode: string, retryable: boolean) {
    const retry = retryable && job.chargedAttempts < job.maxAttempts && job.operationDeadlineAt > new Date(clock.getTime() + 5000);
    const updated = await tx.outboundProbe.update({ where: { id: job.id }, data: { status: retry ? "queued" : "failed", generation: retry ? { increment: 1 } : job.generation,
      attemptToken: null, executorOwner: null, leaseExpiresAt: null, errorCode,
      retryAt: retry ? new Date(clock.getTime() + Math.min(60_000, 5000 * 2 ** job.chargedAttempts)) : null, completedAt: retry ? null : clock } });
    return this.wake(tx, updated, clock, retry ? "outbound_retry" : "outbound_failed");
  }
  async failExecution(tx: Tx, ref: OutboundProbeReference, context: ExecutorMutationContext, failure: { failureCode: string; retryable: boolean }): Promise<ExecutorMutationResult> {
    const { job, clock } = await this.owned(tx, ref, context);
    return this.finishFailure(tx, job, clock, failure.failureCode, failure.retryable);
  }
  async releaseExecution(tx: Tx, ref: OutboundProbeReference, context: ExecutorMutationContext, release: { reason: string }): Promise<ExecutorMutationResult> {
    const { job, clock } = await this.owned(tx, ref, context);
    if (release.reason === "cancelled") {
      await tx.outboundProbe.update({ where: { id: job.id }, data: { status: "cancelled", completedAt: clock, executorOwner: null, leaseExpiresAt: null, errorCode: "outbound_delivery_cancelled" } });
      return this.wake(tx, job, clock, "outbound_cancelled");
    }
    return this.finishFailure(tx, job, clock, `outbound_${release.reason}`, release.reason !== "cancelled");
  }
  async expireExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string, observation: ExecutorExpiryObservation): Promise<ExecutorExpiryResult> {
    const locked = await this.lockExecution(tx, reference, attemptToken);
    if (locked.kind === "terminal") return { kind: locked.disposition.disposition === "superseded" ? "superseded" : "terminal" };
    const job = await tx.outboundProbe.findUniqueOrThrow({ where: { id: locked.ref.id } }); const clock = await now(tx);
    const due = observation.kind === "lease" ? job.leaseExpiresAt : job.operationDeadlineAt;
    if (!due || due.getTime() !== observation.observedDeadlineAt.getTime()) return due && due > clock ? { kind: "sleep", dueAt: due } : { kind: "superseded" };
    if (due > clock) return { kind: "sleep", dueAt: due };
    const wakes = await this.finishFailure(tx, job, clock, "outbound_delivery_deadline", observation.kind === "lease");
    return { kind: "expired", dispatchIds: wakes.dispatchIds };
  }

  private async registerJob(tx: Tx, row: OutboundProbe) {
    if (["completed", "failed", "cancelled"].includes(row.status)) return [];
    const dispatch = await appendExecutionDispatch(tx, { deploymentEpoch: row.deploymentEpoch, generation: row.generation,
      kind: "operation_driver", subject: { kind: "outbound_probe", id: row.id }, inputHash: row.inputHash, dueAt: row.createdAt });
    return [dispatch.reference.dispatchId];
  }

  private async confirm(jobId: string, ids: readonly string[]) {
    if (!ids.length) return;
    try { await this.dependencies.register(ids); }
    catch { throw new OutboundProbeError("outbound_probe_unavailable", { jobId }); }
  }
}
