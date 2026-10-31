import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type ClipPreparation } from "@prisma/client";
import { executionDispatchReferenceSchema, sourceVideoBindingSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { clipPreparationInputSchema, type ClipPreparationInput } from "@narriflow/validators/clip-preparation";
import { clipPreparationBinding, encodeClipPreparationInput } from "./clip-preparation-input";
import { decodeClipEditorDocumentFromStorage, decodeFrozenClipEditorDocument } from "./clip-editor-document-codec";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { accessibleProjectWhere } from "./project-access";
import { lockWorkspaceUsage } from "./processing-usage";
import { uuidV5 } from "./uuid-v5";
import { admitMediaCleanupObligations } from "./media-cleanup";

type Tx = Prisma.TransactionClient;
const namespace = "7d4f8579-d68c-5240-bd5e-05411d012f22";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deadlineMs = 45 * 60_000;
export class ClipPreparationError extends Error {
  constructor(readonly code: "clip_preparation_unavailable" | "clip_preparation_input_invalid", readonly preparationId?: string) { super(code); this.name = "ClipPreparationError"; }
}
export interface ClipPreparationDependencies {
  toolchainFingerprint: string;
  engineHash: string;
  storage: { write(key: string, bytes: Uint8Array): Promise<{ etag: string; byteLength: number; sha256: string }> };
  register(ids: readonly string[]): Promise<void>;
}
export interface ClipPreparationAdmission {
  kind: "wait" | "ready" | "failed";
  preparationId: string;
  bindingHash: string;
  dueAt: Date;
  dispatchIds: string[];
}

async function now(tx: Tx): Promise<Date> {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  if (!clock) throw new ClipPreparationError("clip_preparation_unavailable");
  return clock.now;
}

/** Owns immutable preparation admission and publication. Native code receives
 * one sealed capsule and assigned artifacts; it never reads domain tables. */
export class ClipPreparationService {
  constructor(private readonly database: PrismaClient, private readonly dependencies: ClipPreparationDependencies) {
    if (![dependencies.engineHash, dependencies.toolchainFingerprint].every(value => /^[a-f0-9]{64}$/.test(value))) throw new ClipPreparationError("clip_preparation_input_invalid");
  }

  private async inputForGroup(tx: Tx, reference: ExecutionDispatchReference) {
    const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT epoch FROM "ExecutionEpoch" WHERE id = 1 FOR SHARE`;
    const record = await readExecutionDispatch(tx, reference.dispatchId);
    if (!epoch || reference.kind !== "operation_driver" || reference.subject.kind !== "render_group" || reference.deploymentEpoch !== epoch.epoch ||
      !record || JSON.stringify(record.reference) !== JSON.stringify(reference)) throw new ClipPreparationError("clip_preparation_input_invalid");
    const initial = await tx.renderGroup.findUnique({ where: { id: reference.subject.id }, include: { workflowRun: { include: { project: true } } } });
    if (!initial) throw new ClipPreparationError("clip_preparation_input_invalid");
    await lockWorkspaceUsage(tx, initial.workflowRun.project.workspaceId);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${initial.workflowRun.projectId}, 0)) IS NULL AS locked`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${initial.workflowRun.projectId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id = ${initial.workflowRunId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "RenderGroup" WHERE id = ${initial.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Clip" WHERE id = ${initial.clipId}::uuid FOR UPDATE`;
    const clock = await now(tx);
    const group = await tx.renderGroup.findUniqueOrThrow({ where: { id: initial.id }, include: { workflowRun: true, members: { orderBy: { clipRenderId: "asc" } } } });
    const project = await tx.project.findFirst({ where: { id: group.workflowRun.projectId, ...accessibleProjectWhere(clock), workspace: { status: "active" } } });
    const clip = await tx.clip.findFirst({ where: { id: group.clipId, projectId: group.workflowRun.projectId } });
    if (!project || !clip || project.ingestStatus !== "ready" || !project.sourceStorageKey || group.deploymentEpoch !== epoch.epoch || group.generation !== reference.generation ||
      group.workflowRun.deploymentEpoch !== epoch.epoch || group.workflowRun.stage !== "clip_rendering" || !["waiting", "queued"].includes(group.workflowRun.status) ||
      group.workflowRun.leaseOwner || group.workflowRun.attemptId || !["queued", "running"].includes(group.status) ||
      group.members.length === 0 || group.members.some(member => member.invalidatedAt !== null)) throw new ClipPreparationError("clip_preparation_input_invalid");
    const source = await tx.executionArtifact.findUnique({ where: { storageKey: project.sourceStorageKey } });
    if (!source || source.role !== "source_video" || !source.committedAt || source.byteLength === null || !source.etag || !source.checksumSha256 ||
      source.byteLength !== project.sourceSizeBytes) throw new ClipPreparationError("clip_preparation_input_invalid");
    const measured = sourceVideoBindingSchema.parse(source.sourceVideoBinding);
    const probe = clipPreparationInputSchema.shape.sourceProbe.parse(project.sourceProbe);
    if (measured.projectId !== project.id || measured.sourceRevision !== project.sourceRevision || JSON.stringify(measured.probe) !== JSON.stringify(probe)) throw new ClipPreparationError("clip_preparation_input_invalid");
    const configuration: unknown = JSON.parse(group.exportIdentity);
    if (!Array.isArray(configuration) || configuration.length !== 5 || !["automatic", "export"].includes(configuration[0]) ||
      !Number.isSafeInteger(configuration[2]) || configuration[2] < 0 || typeof configuration[3] !== "string" || typeof configuration[4] !== "boolean") throw new ClipPreparationError("clip_preparation_input_invalid");
    const frozen = configuration[0] === "export";
    if ((configuration[1] === null) === frozen || (!frozen && clip.editorRevision !== configuration[2])) throw new ClipPreparationError("clip_preparation_input_invalid");
    const variants = await tx.clipRender.findMany({ where: { id: { in: group.members.map(member => member.clipRenderId) } }, include: { exportVariant: true }, orderBy: { id: "asc" } });
    if (variants.length !== group.members.length || variants.some(variant => variant.clipId !== clip.id || variant.workflowRunId !== group.workflowRunId ||
      variant.resolution !== configuration[3] || (variant.editorRevision ?? clip.editorRevision) !== configuration[2] || (variant.exportVariant?.exportId ?? null) !== configuration[1])) throw new ClipPreparationError("clip_preparation_input_invalid");
    const document = frozen ? decodeFrozenClipEditorDocument(variants[0]!.clipSnapshot, probe.durationSec) : decodeClipEditorDocumentFromStorage(clip, { durationSec: probe.durationSec, wholeSource: clip.wholeSource });
    const first = frozen ? variants[0]!.clipSnapshot as Record<string, unknown> : clip;
    const wholeSource = first.wholeSource, llmModel = first.llmModel;
    if (typeof wholeSource !== "boolean" || typeof llmModel !== "string" || !llmModel) throw new ClipPreparationError("clip_preparation_input_invalid");
    if (frozen && variants.some(variant => digest(decodeFrozenClipEditorDocument(variant.clipSnapshot, probe.durationSec)) !== digest(document))) throw new ClipPreparationError("clip_preparation_input_invalid");
    const base = { version: 1 as const, kind: "prepare_clip" as const, preparationId: "00000000-0000-0000-0000-000000000000", projectId: project.id, clipId: clip.id,
      sourceRevision: project.sourceRevision, editorRevision: configuration[2] as number, engineHash: this.dependencies.engineHash, toolchainFingerprint: this.dependencies.toolchainFingerprint,
      source: { storageKey: source.storageKey, etag: source.etag, byteLength: Number(source.byteLength), sha256: source.checksumSha256 }, sourceProbe: probe, document, wholeSource, llmModel };
    const bindingHash = await clipPreparationBinding(base);
    const id = uuidV5(namespace, JSON.stringify([epoch.epoch, clip.id, bindingHash]));
    if ((group.preparationId !== null && group.preparationId !== id) || (group.status === "running" && group.preparationId === null)) throw new ClipPreparationError("clip_preparation_input_invalid");
    const input: ClipPreparationInput = { ...base, preparationId: id, bindingHash };
    return { input, groupId: group.id, deploymentEpoch: epoch.epoch, clock, groupDeadlineAt: group.operationDeadlineAt };
  }

  private async admission(tx: Tx, row: ClipPreparation, groupId: string): Promise<ClipPreparationAdmission> {
    await tx.renderGroup.updateMany({ where: { id: groupId, preparationId: null, status: "queued", attemptToken: null, leaseOwner: null }, data: { preparationId: row.id } });
    if ((await tx.renderGroup.findUniqueOrThrow({ where: { id: groupId }, select: { preparationId: true } })).preparationId !== row.id) throw new ClipPreparationError("clip_preparation_input_invalid");
    const kind = row.status === "completed" ? "ready" : ["failed", "superseded"].includes(row.status) ? "failed" : "wait";
    const dispatchIds: string[] = [];
    if (kind === "wait") dispatchIds.push((await appendExecutionDispatch(tx, { deploymentEpoch: row.deploymentEpoch, kind: "operation_driver", subject: { kind: "clip_preparation", id: row.id }, generation: row.generation,
      inputHash: row.inputHash, dueAt: row.retryAt ?? row.createdAt })).reference.dispatchId);
    return { kind, preparationId: row.id, bindingHash: row.bindingHash, dueAt: row.operationDeadlineAt, dispatchIds };
  }

  async admitForGroup(value: ExecutionDispatchReference): Promise<ClipPreparationAdmission> {
    const reference = executionDispatchReferenceSchema.parse(value);
    const prepared = await this.database.$transaction(async tx => {
      const frozen = await this.inputForGroup(tx, reference);
      const existing = await tx.clipPreparation.findUnique({ where: { id: frozen.input.preparationId } });
      const key = `projects/${frozen.input.projectId}/preparations/${frozen.input.preparationId}/${crypto.randomUUID()}.json`;
      if (!existing) await admitMediaCleanupObligations(tx.mediaCleanupObligation, [{ origin: "clip_preparation_input", cleanupClass: "execution_input", projectId: frozen.input.projectId,
        clipId: frozen.input.clipId, objectKey: key, notBefore: new Date(frozen.clock.getTime() + deadlineMs + 120_000) }]);
      return { ...frozen, key, existing: existing ? await this.admission(tx, existing, frozen.groupId) : null };
    });
    let result = prepared.existing;
    if (!result) {
      const encoded = await encodeClipPreparationInput(prepared.input);
      const key = prepared.key;
      const stored = await this.dependencies.storage.write(key, encoded.bytes);
      if (stored.byteLength !== encoded.byteLength || stored.sha256 !== encoded.sha256 || !/^"[^\r\n"]+"$/.test(stored.etag)) throw new ClipPreparationError("clip_preparation_input_invalid");
      result = await this.database.$transaction(async tx => {
        const fresh = await this.inputForGroup(tx, reference);
        if (fresh.input.bindingHash !== prepared.input.bindingHash || fresh.input.preparationId !== prepared.input.preparationId) throw new ClipPreparationError("clip_preparation_input_invalid");
        const deadline = new Date(Math.min(fresh.clock.getTime() + deadlineMs, fresh.groupDeadlineAt?.getTime() ?? Infinity));
        if (deadline <= fresh.clock) throw new ClipPreparationError("clip_preparation_input_invalid");
        const row = await tx.clipPreparation.upsert({ where: { id: fresh.input.preparationId }, update: {}, create: {
          id: fresh.input.preparationId, projectId: fresh.input.projectId, clipId: fresh.input.clipId, sourceRevision: fresh.input.sourceRevision, editorRevision: fresh.input.editorRevision,
          bindingHash: fresh.input.bindingHash, engineHash: fresh.input.engineHash, inputHash: digest(["clip-preparation-v1", fresh.input.preparationId, fresh.input.bindingHash]),
          inputStorageKey: key, inputEtag: stored.etag, inputByteLength: BigInt(stored.byteLength), inputChecksumSha256: stored.sha256,
          deploymentEpoch: fresh.deploymentEpoch, createdAt: fresh.clock, operationDeadlineAt: deadline,
        } });
        await tx.mediaCleanupObligation.updateMany({ where: { origin: "clip_preparation_input", cleanupClass: "execution_input", objectKey: row.inputStorageKey, completedAt: null },
          data: { nextAttemptAt: new Date(row.operationDeadlineAt.getTime() + 120_000) } });
        return this.admission(tx, row, fresh.groupId);
      });
    }
    try { await this.dependencies.register(result.dispatchIds); }
    catch { throw new ClipPreparationError("clip_preparation_unavailable", result.preparationId); }
    return result;
  }
}
