import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type ThumbnailFrameOperation } from "@prisma/client";
import { requestThumbnailFrameSchema, workspaceAllowsCapability, type RequestThumbnailFrameInput } from "@narriflow/validators";
import { appendExecutionDispatch } from "./execution-dispatch";
import { readExecutionDispatch } from "./execution-dispatch";
import { accessibleProjectWhere } from "./project-access";
import { requirePlanFeature } from "./plan-features";
import { ThumbnailPreparationError } from "./thumbnail-frame-preparation";
import type { NativeValidationDependencies } from "./native-validation";
import type { NativeValidationCommit, NativeValidationPreparation } from "./native-validation";
import { nativeValidationEvidenceSchema, type NativeValidationEvidence } from "@narriflow/validators/native-validation";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ExecutorDomainControl, ExecutorMutationContext, ExecutorMutationResult, ExecutorExpiryObservation, ExecutorExpiryResult } from "./executor-domain-control";
import { brandOwnerForWorkspace } from "./brand-ownership";

type Tx = Prisma.TransactionClient;
type ReadDb = Pick<Tx, "clipExportVariant" | "executionArtifact" | "workspace" | "workspaceMember" | "project">;
export type ThumbnailFrameRequest = RequestThumbnailFrameInput & { actorUserId: string; workspaceId: string; projectId: string };
export interface ThumbnailFrameExecutionReference { id: string; attemptToken: string; generation: number; deploymentEpoch: number }
const include = { resultAsset: true } as const;
type Row = Prisma.ThumbnailFrameOperationGetPayload<{ include: typeof include }>;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function thumbnailFrameExecutionInputHash(row: Pick<ThumbnailFrameOperation, "id" | "requestFingerprint" | "exportFingerprint" | "deploymentEpoch" | "generation">) {
  return fingerprint(["thumbnail-frame-execution-v1", row.id, row.requestFingerprint, row.exportFingerprint, row.deploymentEpoch, row.generation]);
}
function view(row: Row, replayed = false) {
  if (row.status === "completed" && row.resultAsset?.deletedAt) throw new ThumbnailPreparationError("thumbnail_asset_deleted");
  return { id: row.id, actorUserId: row.createdByUserId, workspaceId: row.workspaceId, projectId: row.projectId, clipId: row.clipId,
    exportVariantId: row.exportVariantId, sourceTimeMs: row.sourceTimeMs, idempotencyKey: row.idempotencyKey, exportFingerprint: row.exportFingerprint,
    status: row.status, attempt: row.attempt, errorCode: row.errorCode,
    asset: row.resultAsset ? { id: row.resultAsset.id, fingerprint: row.resultAsset.fingerprint, deleted: row.resultAsset.deletedAt !== null } : null,
    createdAt: row.createdAt, completedAt: row.completedAt, replayed };
}
async function clock(tx: Tx) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  if (!row) throw new ThumbnailPreparationError("thumbnail_extraction_failed");
  return row.now;
}

export class ThumbnailFrameExecution implements ExecutorDomainControl<ThumbnailFrameExecutionReference, NativeValidationCommit> {
  constructor(private readonly database: PrismaClient, private readonly dependencies: NativeValidationDependencies) {}

  private async authorize(db: ReadDb, input: { workspaceId: string; actorUserId: string }) {
    const workspace = await db.workspace.findUnique({ where: { id: input.workspaceId } });
    const member = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.actorUserId } } });
    const role = workspace?.ownerUserId === input.actorUserId ? "owner" : member?.role;
    if (!workspace || !role || !workspaceAllowsCapability({ role, status: workspace.status }, "publishing.manage")) throw new ThumbnailPreparationError("thumbnail_operation_not_found");
    requirePlanFeature(workspace.pricingTier, "publishing.customThumbnails");
    return workspace;
  }

  private async source(db: ReadDb, input: { workspaceId: string; projectId: string; clipId: string; exportVariantId: string }) {
    const variant = await db.clipExportVariant.findFirst({ where: { id: input.exportVariantId, status: "completed", storageKey: { not: null }, durationSec: { gt: 0 },
      export: { projectId: input.projectId, clipId: input.clipId, project: { workspaceId: input.workspaceId } } }, include: { export: { select: { fingerprint: true } } } });
    if (!variant?.storageKey || !variant.durationSec) throw new ThumbnailPreparationError("thumbnail_source_missing");
    const sealed = await db.executionArtifact.findUnique({ where: { storageKey: variant.storageKey } });
    if (!sealed?.committedAt || sealed.role !== "render_variant" || sealed.contentType !== "video/mp4" || !sealed.etag || !sealed.byteLength || !sealed.checksumSha256 || sealed.byteLength !== variant.sizeBytes) throw new ThumbnailPreparationError("thumbnail_source_missing");
    return { storageKey: variant.storageKey, durationMs: Math.round(variant.durationSec * 1000), exportFingerprint: variant.export.fingerprint,
      etag: sealed.etag, byteLength: sealed.byteLength, sha256: sealed.checksumSha256 };
  }

  async request(raw: ThumbnailFrameRequest) {
    const body = requestThumbnailFrameSchema.parse({ clipId: raw.clipId, exportVariantId: raw.exportVariantId, sourceTimeMs: raw.sourceTimeMs, idempotencyKey: raw.idempotencyKey });
    const input = { actorUserId: raw.actorUserId, workspaceId: raw.workspaceId, projectId: raw.projectId, ...body };
    await this.authorize(this.database, input);
    const source = await this.source(this.database, input);
    if (input.sourceTimeMs >= source.durationMs) throw new ThumbnailPreparationError("thumbnail_frame_time_invalid");
    const object = await this.dependencies.head(source.storageKey).catch(() => null);
    if (!object || object.etag !== source.etag || object.sizeBytes !== Number(source.byteLength) || object.contentType !== "video/mp4") throw new ThumbnailPreparationError("thumbnail_source_missing");
    const requestFingerprint = fingerprint([input.workspaceId, input.projectId, input.clipId, input.exportVariantId, input.sourceTimeMs]);
    const opened = await this.database.$transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      if (!epoch) throw new ThumbnailPreparationError("thumbnail_extraction_failed");
      await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${input.workspaceId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`thumbnail-idempotency:${input.workspaceId}:${input.idempotencyKey}`},0)) IS NULL AS "locked"`;
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${input.projectId}::uuid FOR UPDATE`;
      await this.authorize(tx, input);
      const now = await clock(tx);
      const project = await tx.project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId, ...accessibleProjectWhere(now) } });
      if (!project) throw new ThumbnailPreparationError("thumbnail_operation_not_found");
      const currentSource = await this.source(tx, input);
      if (source.storageKey !== currentSource.storageKey || source.etag !== currentSource.etag || source.exportFingerprint !== currentSource.exportFingerprint) throw new ThumbnailPreparationError("thumbnail_export_changed");
      const byKey = await tx.thumbnailFrameOperation.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } }, include });
      if (byKey && byKey.requestFingerprint !== requestFingerprint) throw new ThumbnailPreparationError("thumbnail_idempotency_conflict");
      const existing = byKey ?? await tx.thumbnailFrameOperation.findUnique({ where: { exportVariantId_sourceTimeMs: { exportVariantId: input.exportVariantId, sourceTimeMs: input.sourceTimeMs } }, include });
      const row = existing ?? await tx.thumbnailFrameOperation.create({ data: { id: randomUUID(), ...body, workspaceId: input.workspaceId, projectId: input.projectId, createdByUserId: input.actorUserId,
        requestFingerprint, exportFingerprint: source.exportFingerprint, deploymentEpoch: epoch.epoch, createdAt: now, operationDeadlineAt: new Date(now.getTime() + 10 * 60_000) }, include });
      return { row, replayed: existing !== null, dispatchIds: await this.dispatch(tx, row) };
    });
    try { await this.dependencies.register(opened.dispatchIds); }
    catch { throw new ThumbnailPreparationError("thumbnail_scheduling_unavailable", "Thumbnail accepted; retry the same request to confirm scheduling", { operationId: opened.row.id }); }
    return view(opened.row, opened.replayed);
  }

  async get(workspaceId: string, projectId: string, id: string) {
    const row = await this.database.thumbnailFrameOperation.findFirst({ where: { id, workspaceId, projectId }, include });
    if (!row) throw new ThumbnailPreparationError("thumbnail_operation_not_found");
    return view(row);
  }

  private async locked(tx: Tx, id: string) {
    const initial = await tx.thumbnailFrameOperation.findUnique({ where: { id } });
    if (!initial) return null;
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${initial.workspaceId}::uuid FOR SHARE`;
    const workspace = await tx.workspace.findUnique({ where: { id: initial.workspaceId } });
    if (!workspace) return null;
    const owner = brandOwnerForWorkspace(workspace);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`native-validation-owner:${owner.workspaceId ?? owner.userId}`},0)) IS NULL AS "locked"`;
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${initial.projectId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ThumbnailFrameOperation" WHERE "id"=${id}::uuid FOR UPDATE`;
    return tx.thumbnailFrameOperation.findUnique({ where: { id } });
  }

  async prepareExecution(reference: ExecutionDispatchReference): Promise<NativeValidationPreparation> {
    return this.database.$transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      const ledger = (await readExecutionDispatch(tx, reference.dispatchId))?.reference;
      if (reference.kind !== "operation_driver" || reference.subject.kind !== "thumbnail_frame" || epoch?.epoch !== reference.deploymentEpoch || !ledger ||
        ledger.subject.id !== reference.subject.id || ledger.kind !== reference.kind || ledger.subject.kind !== reference.subject.kind || ledger.generation !== reference.generation || ledger.inputHash !== reference.inputHash) return { kind: "superseded" };
      const job = await this.locked(tx, reference.subject.id);
      if (!job || job.generation !== reference.generation || job.deploymentEpoch !== reference.deploymentEpoch || thumbnailFrameExecutionInputHash(job) !== reference.inputHash) return { kind: "superseded" };
      if (["completed", "failed"].includes(job.status)) return { kind: "terminal" };
      const now = await clock(tx);
      if (!job.operationDeadlineAt || job.operationDeadlineAt <= now) { await this.failed(tx, job, now, "thumbnail_deadline_expired"); return { kind: "terminal" }; }
      const token = job.claimId ?? randomUUID();
      const dispatch = await appendExecutionDispatch(tx, { kind: "modal_execution", subject: { kind: "thumbnail_frame", id: job.id }, deploymentEpoch: job.deploymentEpoch,
        generation: job.generation, inputHash: reference.inputHash, dueAt: job.createdAt });
      await tx.executionAttempt.upsert({ where: { attemptToken: token }, create: { attemptToken: token, dispatchId: dispatch.reference.dispatchId, deploymentEpoch: job.deploymentEpoch,
        generation: job.generation, inputHash: reference.inputHash, functionName: "asset_validation", operationDeadlineAt: job.operationDeadlineAt }, update: {} });
      if (!job.claimId) await tx.thumbnailFrameOperation.update({ where: { id: job.id }, data: { claimId: token } });
      const until = job.claimExpiresAt ?? job.operationDeadlineAt;
      const deadline = { reference: dispatch.reference, attemptToken: token, kind: job.claimExpiresAt ? "lease" as const : "operation" as const, observedDeadlineAt: until.toISOString() };
      const watchdog = await appendExecutionDispatch(tx, { kind: "operation_driver", subject: { kind: "thumbnail_frame", id: job.id }, deploymentEpoch: job.deploymentEpoch,
        generation: job.generation, inputHash: reference.inputHash, dueAt: until, deadlineKind: deadline.kind, observedDeadlineAt: until });
      return { kind: "waiting", deadline, deliveryId: watchdog.reference.dispatchId, dispatchIds: [watchdog.reference.dispatchId, dispatch.reference.dispatchId] };
    });
  }

  async lockExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string) {
    if (reference.kind !== "modal_execution" || reference.subject.kind !== "thumbnail_frame") return { kind: "terminal" as const, disposition: { disposition: "superseded" as const } };
    const job = await this.locked(tx, reference.subject.id);
    if (!job || job.generation !== reference.generation || job.deploymentEpoch !== reference.deploymentEpoch || thumbnailFrameExecutionInputHash(job) !== reference.inputHash || job.claimId !== attemptToken) return { kind: "terminal" as const, disposition: { disposition: "superseded" as const } };
    if (job.status === "completed") return { kind: "terminal" as const, disposition: { disposition: "completed" as const } };
    if (job.status === "failed") return { kind: "terminal" as const, disposition: { disposition: "failed" as const, failureCode: job.errorCode ?? "thumbnail_extraction_failed" } };
    const now = await clock(tx);
    try {
      await this.authorize(tx, { workspaceId: job.workspaceId, actorUserId: job.createdByUserId });
      if (!await tx.project.findFirst({ where: { id: job.projectId, workspaceId: job.workspaceId, ...accessibleProjectWhere(now) } })) throw new Error("project inaccessible");
      if ((await this.source(tx, job)).exportFingerprint !== job.exportFingerprint) throw new Error("export changed");
    } catch {
      await this.failed(tx, job, now, "thumbnail_access_revoked");
      return { kind: "terminal" as const, disposition: { disposition: "cancelled" as const } };
    }
    return { kind: "current" as const, ref: { id: job.id, attemptToken, generation: job.generation, deploymentEpoch: job.deploymentEpoch } };
  }

  private async owned(tx: Tx, ref: ThumbnailFrameExecutionReference, context: ExecutorMutationContext) {
    const now = await clock(tx);
    const job = await tx.thumbnailFrameOperation.findFirst({ where: { id: ref.id, status: "processing", claimId: context.attemptToken, executorOwner: context.owner,
      generation: context.reference.generation, deploymentEpoch: context.reference.deploymentEpoch, claimExpiresAt: { gt: now }, operationDeadlineAt: { gt: now } } });
    if (!job || ref.attemptToken !== context.attemptToken) throw new ThumbnailPreparationError("thumbnail_claim_lost");
    return { job, now };
  }
  async acquireExecution(tx: Tx, ref: ThumbnailFrameExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const job = await tx.thumbnailFrameOperation.findUniqueOrThrow({ where: { id: ref.id } }); const now = await clock(tx);
    if (job.status !== "queued" || job.executorOwner || job.claimId !== context.attemptToken || job.attempt >= 3 || !job.operationDeadlineAt ||
      job.operationDeadlineAt <= now || job.operationDeadlineAt.getTime() !== context.operationDeadlineAt.getTime()) throw new ThumbnailPreparationError("thumbnail_claim_lost");
    await tx.thumbnailFrameOperation.update({ where: { id: job.id }, data: { status: "processing", executorOwner: context.owner, claimExpiresAt: context.leaseExpiresAt, errorCode: null } });
    return this.wake(tx, job, now, "thumbnail_acquired", context.leaseExpiresAt);
  }
  async renewExecution(tx: Tx, ref: ThumbnailFrameExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    await this.owned(tx, ref, context); await tx.thumbnailFrameOperation.update({ where: { id: ref.id }, data: { claimExpiresAt: context.leaseExpiresAt } }); return undefined;
  }
  async startExecution(tx: Tx, ref: ThumbnailFrameExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const { job } = await this.owned(tx, ref, context);
    if (job.attempt >= 3) throw new ThumbnailPreparationError("thumbnail_retry_exhausted");
    await tx.thumbnailFrameOperation.update({ where: { id: job.id }, data: { attempt: { increment: 1 } } }); return undefined;
  }
  async progressExecution(tx: Tx, ref: ThumbnailFrameExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> { await this.owned(tx, ref, context); return undefined; }

  async commitArtifactExecution(tx: Tx, ref: ThumbnailFrameExecutionReference, context: ExecutorMutationContext, artifact: NativeValidationCommit): Promise<ExecutorMutationResult> {
    const { job, now } = await this.owned(tx, ref, context);
    if (artifact.bindingHash !== thumbnailFrameExecutionInputHash(job)) throw new ThumbnailPreparationError("thumbnail_extraction_invalid");
    const pending = job.validationState && typeof job.validationState === "object" && !Array.isArray(job.validationState) ? job.validationState as { binary?: { artifactId: string; storageKey: string; sha256: string; byteLength: number }; evidence?: NativeValidationEvidence; probeArtifactId?: string } : {};
    if (artifact.role === "thumbnail") {
      if (artifact.contentType !== "image/jpeg" || artifact.byteLength > 20n * 1024n ** 2n || (pending.binary && pending.binary.artifactId !== artifact.artifactId)) throw new ThumbnailPreparationError("thumbnail_extraction_invalid");
      pending.binary = { artifactId: artifact.artifactId, storageKey: artifact.storageKey, sha256: artifact.sha256, byteLength: Number(artifact.byteLength) };
    } else if (artifact.role === "probe") {
      const evidence = nativeValidationEvidenceSchema.parse(artifact.evidence);
      if (artifact.contentType !== "application/json" || artifact.byteLength > 65536n || evidence.kind !== "thumbnail" || evidence.contentType !== "image/jpeg") throw new ThumbnailPreparationError("thumbnail_extraction_invalid");
      pending.evidence = evidence; pending.probeArtifactId = artifact.artifactId;
    } else throw new ThumbnailPreparationError("thumbnail_extraction_invalid");
    if (!pending.binary || !pending.evidence || !pending.probeArtifactId) { await tx.thumbnailFrameOperation.update({ where: { id: job.id }, data: { validationState: pending as Prisma.InputJsonValue } }); return undefined; }
    if (pending.evidence.kind !== "thumbnail" || pending.evidence.sha256 !== pending.binary.sha256 || pending.evidence.byteLength !== pending.binary.byteLength || pending.evidence.mediaKind !== "image") throw new ThumbnailPreparationError("thumbnail_extraction_invalid");
    const otherId = artifact.artifactId === pending.binary.artifactId ? pending.probeArtifactId : pending.binary.artifactId;
    if (!await tx.executionArtifact.findFirst({ where: { id: otherId, attemptToken: context.attemptToken, owner: context.owner, committedAt: { not: null } } })) throw new ThumbnailPreparationError("thumbnail_claim_lost");
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: job.workspaceId } });
    const owner = brandOwnerForWorkspace(workspace); const evidence = pending.evidence;
    let asset = await tx.visualAsset.findFirst({ where: { ...owner, fingerprint: evidence.sha256 } });
    const data = { ...owner, createdByUserId: job.createdByUserId, title: `Frame at ${(job.sourceTimeMs / 1000).toFixed(1)}s`, kind: "image" as const, contentType: "image/jpeg",
      storageKey: pending.binary.storageKey, fingerprint: evidence.sha256, sizeBytes: BigInt(evidence.byteLength), width: evidence.width, height: evidence.height, provenance: "extracted_frame" as const, deletedAt: null };
    if (!asset) asset = await tx.visualAsset.create({ data });
    else if (asset.deletedAt) asset = await tx.visualAsset.update({ where: { id: asset.id }, data });
    await tx.thumbnailFrameOperation.update({ where: { id: job.id }, data: { status: "completed", resultAssetId: asset.id, completedAt: now, executorOwner: null, claimExpiresAt: null, errorCode: null, validationState: Prisma.DbNull } });
    await tx.projectAnalyticsEvent.create({ data: { projectId: job.projectId, clipId: job.clipId, type: "thumbnail_prepared", metadata: { operationId: job.id, sourceKind: "extracted_frame", sourceTimeMs: job.sourceTimeMs, outcome: "completed" } } });
    return this.wake(tx, job, now, "thumbnail_ready");
  }

  private async wake(tx: Tx, job: ThumbnailFrameOperation, now: Date, wakeKind: string, lease?: Date) {
    const event = await appendExecutionDispatch(tx, { kind: "operation_driver", subject: { kind: "thumbnail_frame", id: job.id }, deploymentEpoch: job.deploymentEpoch,
      generation: job.generation, inputHash: thumbnailFrameExecutionInputHash(job), dueAt: now, wakeKind, ...(lease ? { deadlineKind: "lease" as const, observedDeadlineAt: lease } : {}) });
    return { dispatchIds: [event.reference.dispatchId] };
  }
  private async failed(tx: Tx, job: ThumbnailFrameOperation, now: Date, errorCode: string) {
    await tx.thumbnailFrameOperation.update({ where: { id: job.id }, data: { status: "failed", errorCode, completedAt: now, executorOwner: null, claimExpiresAt: null, validationState: Prisma.DbNull } });
    return this.wake(tx, job, now, "thumbnail_failed");
  }
  async failExecution(tx: Tx, ref: ThumbnailFrameExecutionReference, context: ExecutorMutationContext, failure: { failureCode: string }): Promise<ExecutorMutationResult> { const { job, now } = await this.owned(tx, ref, context); return this.failed(tx, job, now, failure.failureCode); }
  async releaseExecution(tx: Tx, ref: ThumbnailFrameExecutionReference, context: ExecutorMutationContext, release: { reason: string }): Promise<ExecutorMutationResult> { const { job, now } = await this.owned(tx, ref, context); return this.failed(tx, job, now, `thumbnail_${release.reason}`); }
  async expireExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string, observation: ExecutorExpiryObservation): Promise<ExecutorExpiryResult> {
    const state = await this.lockExecution(tx, reference, attemptToken);
    if (state.kind === "terminal") return { kind: state.disposition.disposition === "superseded" ? "superseded" : "terminal" };
    const job = await tx.thumbnailFrameOperation.findUniqueOrThrow({ where: { id: state.ref.id } }); const now = await clock(tx);
    const due = observation.kind === "lease" ? job.claimExpiresAt : job.operationDeadlineAt;
    if (!due || due.getTime() !== observation.observedDeadlineAt.getTime()) return due && due > now ? { kind: "sleep", dueAt: due } : { kind: "superseded" };
    if (due > now) return { kind: "sleep", dueAt: due };
    return { kind: "expired", dispatchIds: (await this.failed(tx, job, now, "thumbnail_deadline_expired")).dispatchIds };
  }

  async retry(actorUserId: string, workspaceId: string, projectId: string, id: string) {
    const outcome = await this.database.$transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      const job = await this.locked(tx, id);
      if (!epoch || !job || job.workspaceId !== workspaceId || job.projectId !== projectId) throw new ThumbnailPreparationError("thumbnail_operation_not_found");
      await this.authorize(tx, { workspaceId, actorUserId });
      if (job.status === "failed" && job.attempt >= 3) throw new ThumbnailPreparationError("thumbnail_retry_exhausted");
      const now = await clock(tx);
      const row = job.status === "failed" ? await tx.thumbnailFrameOperation.update({ where: { id }, data: { status: "queued", generation: { increment: 1 }, deploymentEpoch: epoch.epoch,
        createdByUserId: actorUserId, errorCode: null, claimId: null, executorOwner: null, claimExpiresAt: null, completedAt: null, validationState: Prisma.DbNull,
        operationDeadlineAt: new Date(now.getTime() + 10 * 60_000) }, include }) : await tx.thumbnailFrameOperation.findUniqueOrThrow({ where: { id }, include });
      return { row, ids: await this.dispatch(tx, row) };
    });
    try { await this.dependencies.register(outcome.ids); } catch { throw new ThumbnailPreparationError("thumbnail_scheduling_unavailable", "Retry the same thumbnail operation to confirm scheduling", { operationId: id }); }
    return view(outcome.row);
  }

  async workInput(id: string) {
    const job = await this.database.thumbnailFrameOperation.findUnique({ where: { id } });
    if (!job || job.status !== "processing" || !job.claimId) throw new ThumbnailPreparationError("thumbnail_operation_not_found");
    const source = await this.source(this.database, job);
    if (source.exportFingerprint !== job.exportFingerprint) throw new ThumbnailPreparationError("thumbnail_export_changed");
    const inputHash = thumbnailFrameExecutionInputHash(job);
    return { functionName: "asset_validation" as const, inputHash,
      command: { kind: "thumbnail" as const, sourceTimeMs: job.sourceTimeMs, expected: { contentType: "video/mp4", byteLength: Number(source.byteLength), sha256: source.sha256 } },
      source: { storageKey: source.storageKey, etag: source.etag, byteLength: source.byteLength, sha256: source.sha256 },
      outputs: [{ role: "thumbnail" as const, contentType: "image/jpeg", maxBytes: 20n * 1024n ** 2n, bindingHash: inputHash }, { role: "probe" as const, contentType: "application/json", maxBytes: 65536n, bindingHash: inputHash }] };
  }

  private async dispatch(tx: Tx, row: ThumbnailFrameOperation) {
    if (["completed", "failed"].includes(row.status)) return [];
    const event = await appendExecutionDispatch(tx, { kind: "operation_driver", subject: { kind: "thumbnail_frame", id: row.id }, deploymentEpoch: row.deploymentEpoch,
      generation: row.generation, inputHash: thumbnailFrameExecutionInputHash(row), dueAt: row.createdAt });
    return [event.reference.dispatchId];
  }
}
