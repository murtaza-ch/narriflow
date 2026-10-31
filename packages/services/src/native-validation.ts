import { createHash, randomUUID } from "node:crypto";
import { readExecutionAdmission, assertExecutionAdmissionOpen } from "./execution-admission";
import { Prisma, type NativeValidationJob, type PrismaClient } from "@prisma/client";
import { nativeValidationEvidenceSchema, nativeValidationInputSchema, type NativeValidationEvidence, type NativeValidationInput } from "@narriflow/validators/native-validation";
import type { ExecutionDeadline, ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { assertBrandMutationAllowed, brandOwnerStoragePrefix, resolveBrandOwner, type BrandActorScope } from "./brand-ownership";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import type { ExecutorArtifactCommit, ExecutorDomainControl, ExecutorMutationContext, ExecutorMutationResult, ExecutorExpiryObservation, ExecutorExpiryResult } from "./executor-domain-control";

type Tx = Prisma.TransactionClient;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deadlineMs = 10 * 60_000;
export class NativeValidationError extends ExpectedDomainFailureError {
  constructor(code: "native_validation_unavailable" | "native_validation_missing" | "native_validation_conflict" | "native_validation_object_invalid", details?: { jobId?: string }) {
    super({ code, kind: code === "native_validation_missing" ? "missing" : code === "native_validation_conflict" ? "conflict" : code === "native_validation_object_invalid" ? "unprocessable" : "unavailable", message: "Asset validation is unavailable", details });
  }
}
export interface NativeValidationDependencies {
  head(key: string): Promise<{ contentType: string | null; sizeBytes: number | null; etag: string }>;
  register(ids: readonly string[]): Promise<void>;
}
export interface NativeValidationReference { id: string; attemptToken: string; generation: number; deploymentEpoch: number }
export interface NativeValidationCommit extends ExecutorArtifactCommit { evidence?: NativeValidationEvidence }
export type NativeValidationPreparation =
  | { kind: "terminal" | "superseded" }
  | { kind: "sleep"; dueAt: Date }
  | { kind: "dependency_wait"; dueAt: Date; deadlineDispatchId: string; dispatchIds: readonly string[] }
  | { kind: "waiting"; deadline: ExecutionDeadline; deliveryId: string; dispatchIds: readonly string[] };

async function now(tx: Tx) {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  if (!clock) throw new NativeValidationError("native_validation_unavailable");
  return clock.now;
}

function publicJob(row: NativeValidationJob) {
  return { jobId: row.id, status: row.status === "completed" ? "ready" as const : row.status === "failed" || row.status === "cancelled" ? "failed" as const : "pending" as const,
    kind: row.kind === "brand_font" ? "font" as const : "visual" as const,
    result: row.status === "completed" ? row.result : null, errorCode: row.errorCode, replayed: false };
}

/** The job is pending until the native executor commits both sealed outputs.
 * Uploaded source bytes never become an insertable asset directly. */
export class NativeValidationService implements ExecutorDomainControl<NativeValidationReference, NativeValidationCommit> {
  constructor(private readonly database: PrismaClient, private readonly dependencies: NativeValidationDependencies) {}

  async admit(scope: BrandActorScope, raw: NativeValidationInput) {
    const validated = nativeValidationInputSchema.parse(raw);
    const input = { ...validated, fingerprint: validated.fingerprint.toLowerCase() };
    assertBrandMutationAllowed(scope, input.kind === "font" ? "brand.customFonts" : "brand.profiles");
    const collection = input.kind === "font" ? "brand-fonts" : "visual-assets";
    if (!input.key.startsWith(brandOwnerStoragePrefix(scope, collection))) throw new NativeValidationError("native_validation_object_invalid");
    const requestFingerprint = digest(input);
    const kind = input.kind === "font" ? "brand_font" : "visual_asset";
    const known = await this.database.nativeValidationJob.findUnique({ where: { workspaceId_kind_requestFingerprint: { workspaceId: scope.workspaceId, kind, requestFingerprint } } });
    if (known) {
      const ids = await this.database.$transaction(tx => this.registerJob(tx, known));
      await this.confirm(known.id, ids);
      return { ...publicJob(known), replayed: true };
    }
    const object = await this.dependencies.head(input.key);
    if (object.contentType !== input.contentType || object.sizeBytes !== input.sizeBytes || !object.etag || object.etag.length > 160) throw new NativeValidationError("native_validation_object_invalid");
    const admitted = await this.database.$transaction(async tx => {
      const epoch = await readExecutionAdmission(tx);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`native-validation:${scope.workspaceId}:${kind}:${requestFingerprint}`},0)) IS NULL AS "locked"`;
      const replay = await tx.nativeValidationJob.findUnique({ where: { workspaceId_kind_requestFingerprint: { workspaceId: scope.workspaceId, kind, requestFingerprint } } });
      if (replay) return { row: replay, ids: await this.registerJob(tx, replay), replayed: true };
      assertExecutionAdmissionOpen(epoch);
      const clock = await now(tx); const owner = resolveBrandOwner(scope); const id = randomUUID();
      const row = await tx.nativeValidationJob.create({ data: { id, workspaceId: scope.workspaceId, createdByUserId: scope.actorUserId,
        ownerUserId: owner.userId, ownerWorkspaceId: owner.workspaceId, kind, requestFingerprint,
        input: input as Prisma.InputJsonValue, inputHash: digest(["native-validation-v1", id, epoch.epoch, requestFingerprint, object.etag, input.sizeBytes]),
        inputStorageKey: input.key, inputEtag: object.etag, inputByteLength: BigInt(input.sizeBytes), deploymentEpoch: epoch.epoch,
        createdAt: clock, operationDeadlineAt: new Date(clock.getTime() + deadlineMs) } });
      return { row, ids: await this.registerJob(tx, row), replayed: false };
    });
    await this.confirm(admitted.row.id, admitted.ids);
    return { ...publicJob(admitted.row), replayed: admitted.replayed };
  }

  async get(scope: BrandActorScope, id: string) {
    const owner = resolveBrandOwner(scope);
    const row = await this.database.nativeValidationJob.findFirst({ where: { id, workspaceId: scope.workspaceId, ownerUserId: owner.userId, ownerWorkspaceId: owner.workspaceId } });
    if (!row) throw new NativeValidationError("native_validation_missing");
    return publicJob(row);
  }

  /** The Workflow prepares one admitted subject; it never scans or owns a lease. */
  async prepareExecution(reference: ExecutionDispatchReference): Promise<NativeValidationPreparation> {
    return this.database.$transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      if (reference.kind !== "operation_driver" || reference.subject.kind !== "native_validation" || epoch?.epoch !== reference.deploymentEpoch) return { kind: "superseded" };
      const registered = await readExecutionDispatch(tx, reference.dispatchId);
      const ledger = registered?.reference;
      if (!ledger || ledger.kind !== reference.kind || ledger.subject.kind !== reference.subject.kind || ledger.subject.id !== reference.subject.id || ledger.generation !== reference.generation || ledger.deploymentEpoch !== reference.deploymentEpoch || ledger.inputHash !== reference.inputHash) return { kind: "superseded" };
      const initial = await tx.nativeValidationJob.findUnique({ where: { id: reference.subject.id } });
      if (!initial) return { kind: "superseded" };
      await this.lockOwner(tx, initial);
      await tx.$queryRaw`SELECT "id" FROM "NativeValidationJob" WHERE "id"=${initial.id}::uuid FOR UPDATE`;
      const job = await tx.nativeValidationJob.findUniqueOrThrow({ where: { id: initial.id } }); const clock = await now(tx);
      if (job.deploymentEpoch !== epoch.epoch || job.generation !== reference.generation || job.inputHash !== reference.inputHash) return { kind: "superseded" };
      if (["completed", "failed", "cancelled"].includes(job.status)) return { kind: "terminal" };
      if (job.retryAt && job.retryAt > clock) return { kind: "sleep", dueAt: job.retryAt };
      if (job.operationDeadlineAt <= clock) { await this.finishFailure(tx, job, clock, "asset_validation_deadline", false); return { kind: "terminal" }; }
      const token = job.attemptToken ?? randomUUID();
      const dispatch = await appendExecutionDispatch(tx, { deploymentEpoch: job.deploymentEpoch, generation: job.generation, kind: "modal_execution",
        subject: { kind: "native_validation", id: job.id }, inputHash: job.inputHash, dueAt: job.retryAt ?? job.createdAt });
      await tx.executionAttempt.upsert({ where: { attemptToken: token }, create: { attemptToken: token, dispatchId: dispatch.reference.dispatchId,
        deploymentEpoch: job.deploymentEpoch, generation: job.generation, inputHash: job.inputHash, functionName: "asset_validation", operationDeadlineAt: job.operationDeadlineAt }, update: {} });
      if (!job.attemptToken) await tx.nativeValidationJob.update({ where: { id: job.id }, data: { attemptToken: token } });
      const until = job.leaseExpiresAt ?? job.operationDeadlineAt;
      const deadline = { reference: dispatch.reference, attemptToken: token, kind: job.leaseExpiresAt ? "lease" as const : "operation" as const, observedDeadlineAt: until.toISOString() };
      const watchdog = await appendExecutionDispatch(tx, { deploymentEpoch: job.deploymentEpoch, generation: job.generation, kind: "operation_driver",
        subject: { kind: "native_validation", id: job.id }, inputHash: job.inputHash, dueAt: until, deadlineKind: deadline.kind, observedDeadlineAt: until });
      return { kind: "waiting", deadline, deliveryId: watchdog.reference.dispatchId, dispatchIds: [watchdog.reference.dispatchId, dispatch.reference.dispatchId] };
    });
  }

  private async lockOwner(tx: Tx, job: NativeValidationJob) {
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${job.workspaceId}::uuid FOR SHARE`;
    const ownerKey = `native-validation-owner:${job.ownerWorkspaceId ?? job.ownerUserId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerKey},0)) IS NULL AS "locked"`;
  }

  async lockExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string) {
    const initial = await tx.nativeValidationJob.findUnique({ where: { id: reference.subject.id } });
    if (!initial || reference.subject.kind !== "native_validation" || reference.kind !== "modal_execution") return { kind: "terminal" as const, disposition: { disposition: "superseded" as const } };
    await this.lockOwner(tx, initial);
    await tx.$queryRaw`SELECT "id" FROM "NativeValidationJob" WHERE "id"=${initial.id}::uuid FOR UPDATE`;
    const job = await tx.nativeValidationJob.findUniqueOrThrow({ where: { id: initial.id } });
    if (job.deploymentEpoch !== reference.deploymentEpoch || job.generation !== reference.generation || job.inputHash !== reference.inputHash || job.attemptToken !== attemptToken) return { kind: "terminal" as const, disposition: { disposition: "superseded" as const } };
    if (job.status === "completed") return { kind: "terminal" as const, disposition: { disposition: "completed" as const } };
    if (job.status === "cancelled") return { kind: "terminal" as const, disposition: { disposition: "cancelled" as const } };
    if (job.status === "failed") return { kind: "terminal" as const, disposition: { disposition: "failed" as const, failureCode: job.errorCode ?? "asset_validation_failed" } };
    const workspace = await tx.workspace.findUnique({ where: { id: job.workspaceId } });
    const membership = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: job.workspaceId, userId: job.createdByUserId } } });
    try {
      const actorUser=await tx.user.findUnique({where:{id:job.createdByUserId},select:{deletedAt:true}});
      if(!actorUser || actorUser.deletedAt)throw new Error("deleted actor");
      if (!workspace || (job.ownerUserId ? workspace.personalOwnerUserId !== job.ownerUserId : workspace.personalOwnerUserId !== null || workspace.id !== job.ownerWorkspaceId) || (workspace.ownerUserId !== job.createdByUserId && !membership)) throw new Error("missing actor");
      const actor = { actorUserId: job.createdByUserId, workspaceId: workspace.id, workspaceOwnerUserId: workspace.ownerUserId, role: workspace.ownerUserId === job.createdByUserId ? "owner" as const : membership!.role, status: workspace.status, pricingTier: workspace.pricingTier, isPersonalWorkspace: workspace.personalOwnerUserId !== null };
      assertBrandMutationAllowed(actor,job.kind === "brand_font" ? "brand.customFonts" : "brand.profiles");
    } catch {
      await tx.nativeValidationJob.update({ where: { id: job.id }, data: { status: "cancelled", completedAt: await now(tx), executorOwner: null, leaseExpiresAt: null } });
      return { kind: "terminal" as const, disposition: { disposition: "cancelled" as const } };
    }
    return { kind: "current" as const, ref: { id: job.id, attemptToken, generation: job.generation, deploymentEpoch: job.deploymentEpoch } };
  }

  private async owned(tx: Tx, ref: NativeValidationReference, context: ExecutorMutationContext) {
    const clock = await now(tx);
    const job = await tx.nativeValidationJob.findFirst({ where: { id: ref.id, status: "processing", attemptToken: context.attemptToken, executorOwner: context.owner,
      generation: context.reference.generation, deploymentEpoch: context.reference.deploymentEpoch, leaseExpiresAt: { gt: clock }, operationDeadlineAt: { gt: clock } } });
    if (!job || ref.attemptToken !== context.attemptToken) throw new NativeValidationError("native_validation_conflict");
    return { job, clock };
  }

  async acquireExecution(tx: Tx, ref: NativeValidationReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const clock = await now(tx);
    const job = await tx.nativeValidationJob.findUniqueOrThrow({ where: { id: ref.id } });
    if (job.status !== "queued" || job.executorOwner || job.attemptToken !== context.attemptToken || job.chargedAttempts >= job.maxAttempts || job.operationDeadlineAt <= clock ||
      (job.retryAt && job.retryAt > clock) || job.operationDeadlineAt.getTime() !== context.operationDeadlineAt.getTime()) throw new NativeValidationError("native_validation_conflict");
    await tx.nativeValidationJob.update({ where: { id: job.id }, data: { status: "processing", executorOwner: context.owner, leaseExpiresAt: context.leaseExpiresAt, errorCode: null } });
    return this.wake(tx, job, clock, "validation_acquired", context.leaseExpiresAt);
  }
  async renewExecution(tx: Tx, ref: NativeValidationReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    await this.owned(tx, ref, context);
    await tx.nativeValidationJob.update({ where: { id: ref.id }, data: { leaseExpiresAt: context.leaseExpiresAt } });
    return undefined;
  }
  async startExecution(tx: Tx, ref: NativeValidationReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const { job } = await this.owned(tx, ref, context);
    if (job.chargedAttempts >= job.maxAttempts) throw new NativeValidationError("native_validation_conflict");
    await tx.nativeValidationJob.update({ where: { id: ref.id }, data: { chargedAttempts: { increment: 1 } } });
    return undefined;
  }
  async progressExecution(tx: Tx, ref: NativeValidationReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> { await this.owned(tx, ref, context); return undefined; }

  async commitArtifactExecution(tx: Tx, ref: NativeValidationReference, context: ExecutorMutationContext, artifact: NativeValidationCommit): Promise<ExecutorMutationResult> {
    const { job, clock } = await this.owned(tx, ref, context);
    const input = nativeValidationInputSchema.parse(job.input);
    if (artifact.bindingHash !== job.inputHash) throw new NativeValidationError("native_validation_object_invalid");
    const pending = job.result && typeof job.result === "object" && !Array.isArray(job.result) ? job.result as { binary?: { artifactId: string; storageKey: string }; evidence?: NativeValidationEvidence; probeArtifactId?: string } : {};
    const expectedRole = input.kind === "font" ? "validated_font" : "validated_asset";
    if (artifact.role === expectedRole) {
      if (artifact.sha256 !== input.fingerprint || artifact.byteLength !== BigInt(input.sizeBytes) || artifact.contentType !== input.contentType) throw new NativeValidationError("native_validation_object_invalid");
      if (pending.binary && pending.binary.artifactId !== artifact.artifactId) throw new NativeValidationError("native_validation_conflict");
      pending.binary = { artifactId: artifact.artifactId, storageKey: artifact.storageKey };
    } else if (artifact.role === "probe") {
      const evidence = nativeValidationEvidenceSchema.parse(artifact.evidence);
      if (artifact.byteLength > 64n * 1024n || artifact.contentType !== "application/json" || evidence.kind !== input.kind || evidence.sha256 !== input.fingerprint || evidence.byteLength !== input.sizeBytes ||
        (evidence.kind === "visual" && evidence.contentType !== input.contentType)) throw new NativeValidationError("native_validation_object_invalid");
      if (evidence.kind === "font") {
        const format = input.contentType === "font/woff2" ? "woff2" : input.contentType === "font/otf" ? "otf" : "ttf";
        if (evidence.format !== format || evidence.family !== evidence.face.name || evidence.weight !== evidence.face.weight) throw new NativeValidationError("native_validation_object_invalid");
      }
      pending.evidence = evidence; pending.probeArtifactId = artifact.artifactId;
    } else throw new NativeValidationError("native_validation_object_invalid");
    if (!pending.binary || !pending.evidence || !pending.probeArtifactId) {
      await tx.nativeValidationJob.update({ where: { id: job.id }, data: { result: pending as Prisma.InputJsonValue } });
      return undefined;
    }
    // A reference alone is not sealed evidence. The other output must already
    // be committed by this exact attempt/owner; the current output is committed
    // atomically by ExecutorControl immediately after this domain transition.
    const otherId = artifact.artifactId === pending.binary.artifactId ? pending.probeArtifactId : pending.binary.artifactId;
    const other = await tx.executionArtifact.findFirst({ where: { id: otherId, attemptToken: context.attemptToken, owner: context.owner, committedAt: { not: null } } });
    if (!other) throw new NativeValidationError("native_validation_conflict");
    const owner = { userId: job.ownerUserId, workspaceId: job.ownerWorkspaceId };
    let result: { assetId: string; fingerprint: string };
    if (pending.evidence.kind === "font") {
      const evidence = pending.evidence;
      const existing = await tx.brandFont.findFirst({ where: { ...owner, fingerprint: evidence.sha256 } });
      const data = { ...owner, licenseConfirmedByUserId: job.createdByUserId, family: evidence.family, style: evidence.style, weight: evidence.weight, format: evidence.format,
        storageKey: pending.binary.storageKey, sizeBytes: BigInt(evidence.byteLength), fingerprint: evidence.sha256, face: evidence.face as Prisma.InputJsonValue,
        licenseConfirmedAt: clock, deletedAt: null };
      const font = existing ? await tx.brandFont.update({ where: { id: existing.id }, data: existing.deletedAt || !existing.face ? data : {} }) : await tx.brandFont.create({ data });
      result = { assetId: font.id, fingerprint: font.fingerprint };
    } else {
      const evidence = pending.evidence;
      const existing = await tx.visualAsset.findFirst({ where: { ...owner, fingerprint: evidence.sha256 } });
      const data = { ...owner, createdByUserId: job.createdByUserId, title: input.kind === "visual" ? input.title : "Validated asset", kind: evidence.mediaKind,
        storageKey: pending.binary.storageKey, contentType: evidence.contentType, sizeBytes: BigInt(evidence.byteLength), width: evidence.width, height: evidence.height,
        durationSec: evidence.durationSec, fingerprint: evidence.sha256, provenance: input.kind === "visual" ? input.provenance : "uploaded" as const, deletedAt: null };
      const asset = existing ? await tx.visualAsset.update({ where: { id: existing.id }, data: existing.deletedAt ? data : {} }) : await tx.visualAsset.create({ data });
      result = { assetId: asset.id, fingerprint: asset.fingerprint };
    }
    await tx.nativeValidationJob.update({ where: { id: job.id }, data: { status: "completed", result, errorCode: null, completedAt: clock, executorOwner: null, leaseExpiresAt: null } });
    return this.wake(tx, job, clock, "validation_ready");
  }

  private async wake(tx: Tx, job: NativeValidationJob, clock: Date, wakeKind: string, lease?: Date) {
    const dispatch = await appendExecutionDispatch(tx, { deploymentEpoch: job.deploymentEpoch, generation: job.generation, kind: "operation_driver", subject: { kind: "native_validation", id: job.id },
      inputHash: job.inputHash, dueAt: clock, wakeKind, ...(lease ? { deadlineKind: "lease" as const, observedDeadlineAt: lease } : {}) });
    return { dispatchIds: [dispatch.reference.dispatchId] };
  }

  private async finishFailure(tx: Tx, job: NativeValidationJob, clock: Date, errorCode: string, retryable: boolean) {
    const retry = retryable && job.chargedAttempts < job.maxAttempts && job.operationDeadlineAt > new Date(clock.getTime() + 5000);
    const updated = await tx.nativeValidationJob.update({ where: { id: job.id }, data: { status: retry ? "queued" : "failed", generation: retry ? { increment: 1 } : job.generation,
      attemptToken: null, executorOwner: null, leaseExpiresAt: null, result: Prisma.DbNull, errorCode,
      retryAt: retry ? new Date(clock.getTime() + Math.min(60_000, 5000 * 2 ** job.chargedAttempts)) : null, completedAt: retry ? null : clock } });
    return this.wake(tx, updated, clock, retry ? "validation_retry" : "validation_failed");
  }
  async failExecution(tx: Tx, ref: NativeValidationReference, context: ExecutorMutationContext, failure: { failureCode: string; retryable: boolean }): Promise<ExecutorMutationResult> {
    const { job, clock } = await this.owned(tx, ref, context);
    return this.finishFailure(tx, job, clock, failure.failureCode, failure.retryable);
  }
  async releaseExecution(tx: Tx, ref: NativeValidationReference, context: ExecutorMutationContext, release: { reason: string }): Promise<ExecutorMutationResult> {
    const { job, clock } = await this.owned(tx, ref, context);
    if (release.reason === "cancelled") {
      await tx.nativeValidationJob.update({ where: { id: job.id }, data: { status: "cancelled", completedAt: clock, executorOwner: null, leaseExpiresAt: null, errorCode: "asset_validation_cancelled" } });
      return this.wake(tx, job, clock, "validation_cancelled");
    }
    return this.finishFailure(tx, job, clock, `validation_${release.reason}`, release.reason !== "cancelled");
  }
  async expireExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string, observation: ExecutorExpiryObservation): Promise<ExecutorExpiryResult> {
    const locked = await this.lockExecution(tx, reference, attemptToken);
    if (locked.kind === "terminal") return { kind: locked.disposition.disposition === "superseded" ? "superseded" : "terminal" };
    const job = await tx.nativeValidationJob.findUniqueOrThrow({ where: { id: locked.ref.id } }); const clock = await now(tx);
    const due = observation.kind === "lease" ? job.leaseExpiresAt : job.operationDeadlineAt;
    if (!due || due.getTime() !== observation.observedDeadlineAt.getTime()) return due && due > clock ? { kind: "sleep", dueAt: due } : { kind: "superseded" };
    if (due > clock) return { kind: "sleep", dueAt: due };
    const wakes = await this.finishFailure(tx, job, clock, "asset_validation_deadline", observation.kind === "lease");
    return { kind: "expired", dispatchIds: wakes.dispatchIds };
  }

  private async registerJob(tx: Tx, row: NativeValidationJob) {
    if (["completed", "failed", "cancelled"].includes(row.status)) return [];
    const dispatch = await appendExecutionDispatch(tx, { deploymentEpoch: row.deploymentEpoch, generation: row.generation,
      kind: "operation_driver", subject: { kind: "native_validation", id: row.id }, inputHash: row.inputHash, dueAt: row.createdAt });
    return [dispatch.reference.dispatchId];
  }

  private async confirm(jobId: string, ids: readonly string[]) {
    if (!ids.length) return;
    try { await this.dependencies.register(ids); }
    catch { throw new NativeValidationError("native_validation_unavailable", { jobId }); }
  }
}
