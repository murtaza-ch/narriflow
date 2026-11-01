import {ExecutionDispatchPendingError} from "./execution-dispatch";
import { assertExecutionRestorePage } from "./execution-restore-pages";
import type { ExecutionRestorePage } from "./execution-restore";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type ClipPreparation, type ExecutionArtifact, type RenderGroup } from "@prisma/client";
import { executionDispatchReferenceSchema, sourceVideoBindingSchema, type ExecutionDispatchReference, type ExecutionDeadline } from "@narriflow/validators/execution";
import { clipPreparationInputSchema, clipPreparationResultSchema, clipPreparationReadyObjectsSchema, type ClipPreparationInput, type ClipPreparationResult, type ClipPreparationObject } from "@narriflow/validators/clip-preparation";
import { buildEditedTimeMap, clipAutoLayoutMatchesInputs, CLIP_AUTO_LAYOUT_ENGINE, SCREEN_LAYOUT_ENGINE_VERSION } from "@narriflow/validators";
import { compositionAssetRef, screenLayoutInputFingerprint, splitLayoutInputFingerprint } from "@narriflow/composition-plan";
import { clipPreparationBinding, encodeClipPreparationInput } from "./clip-preparation-input";
import { decodeClipEditorDocumentFromStorage, decodeFrozenClipEditorDocument } from "./clip-editor-document-codec";
import { appendExecutionDispatch, appendExecutionDispatches, readExecutionDispatch } from "./execution-dispatch";
import { accessibleProjectWhere } from "./project-access";
import { lockWorkspaceUsage } from "./processing-usage";
import { uuidV5 } from "./uuid-v5";
import { admitMediaCleanupObligations } from "./media-cleanup";
import { lockPlannedExecutionObject } from "./execution-object-cleanup";
import { clipPreparationTiming, clipPreparationPreviewWindow, resolveDisplayGeometry } from "./clip-preparation-policy";
import type { ExecutorArtifactCommit, ExecutorDomainLock, ExecutorMutationContext, ExecutorMutationResult, ExecutorFailureInput, ExecutorReleaseInput, ExecutorProgressInput, ExecutorExpiryObservation, ExecutorExpiryResult } from "./executor-domain-control";
import { derivePeaksStorageKey } from "./clip-preview-storage";
import type { ExecutorLiveAuthority } from "./executor-control";

type Tx = Prisma.TransactionClient;
const namespace = "7d4f8579-d68c-5240-bd5e-05411d012f22";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const clipPreparationIdentity = (epoch:number,clipId:string,bindingHash:string)=>uuidV5(namespace,JSON.stringify([epoch,clipId,bindingHash]));
export const clipPreparationExecutionInputHash = (id:string,bindingHash:string)=>digest(["clip-preparation-v1",id,bindingHash]);
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
export interface ClipPreparationExecutionReference { id: string; attemptToken: string; input: ClipPreparationInput }
export type ClipPreparationArtifactCommit = ExecutorArtifactCommit & (
  { role: "clip_preview" | "preview_peaks" } | { role: "layout_evidence"; result: ClipPreparationResult }
);
export type ClipPreparationExecution = { kind: "terminal" | "superseded"; dispatchIds: string[] }
  | { kind: "sleep"; dueAt: Date; dispatchIds: string[] }
  | { kind: "waiting"; deadline: ExecutionDeadline; deliveryId: string; dispatchIds: string[] };
export interface ReadyClipPreparation {
  preparationId: string;
  bindingHash: string;
  input: ClipPreparationObject;
  preview: ClipPreparationObject;
  peaks: ClipPreparationObject | null;
  manifest: ClipPreparationObject;
  result: ClipPreparationResult;
}

async function now(tx: Tx): Promise<Date> {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  if (!clock) throw new ClipPreparationError("clip_preparation_unavailable");
  return clock.now;
}

export function validateClipPreparationManifest(input: ClipPreparationInput, raw: ClipPreparationResult): ClipPreparationResult {
    const result = clipPreparationResultSchema.parse(raw), window = clipPreparationPreviewWindow(input), timing = clipPreparationTiming(input);
    if (result.preparationId !== input.preparationId || result.bindingHash !== input.bindingHash || Math.abs(result.preview.startSec - window.startSec) > 0.001 ||
      Math.abs(result.preview.durationSec - window.durationSec) > 0.001 || result.layout.automatic === null ||
      (input.sourceProbe.video === null && (result.layout.screen !== null || result.layout.split !== null)) ||
      (input.sourceProbe.video !== null && (result.layout.screen === null || result.layout.split === null)) ||
      (result.peaks.state === "unavailable" && (result.peaks.reason === "no_audio") !== (input.sourceProbe.audio === null))) throw new ClipPreparationError("clip_preparation_input_invalid");
    const sourceIdentity = compositionAssetRef("source", input.projectId);
    const geometry = resolveDisplayGeometry({ width: input.sourceProbe.video?.width ?? 0, height: input.sourceProbe.video?.height ?? 0, facts: input.sourceProbe.facts });
    const editedDurationSec = buildEditedTimeMap(input.document.deletedRanges, { startSec: timing.startSec, endSec: timing.endSec }).editedDurationSec;
    for (const value of [result.layout.automatic, result.layout.split]) {
      if (!value || "state" in value) continue;
      if (value.sourceIdentity !== sourceIdentity || value.sourceWidth !== (geometry.width || 1) || value.sourceHeight !== (geometry.height || 1) ||
        !clipAutoLayoutMatchesInputs(value, { clipStartSec: timing.startSec, clipEndSec: timing.endSec, deletedRanges: input.document.deletedRanges }) ||
        Math.abs(value.editedDurationSec - editedDurationSec) > 0.075) throw new ClipPreparationError("clip_preparation_input_invalid");
    }
    const automatic = result.layout.automatic;
    if (!("state" in automatic) && automatic.engine !== CLIP_AUTO_LAYOUT_ENGINE) throw new ClipPreparationError("clip_preparation_input_invalid");
    const binding = { sourceIdentity, clipStartSec: timing.startSec, clipEndSec: timing.endSec, deletedRanges: input.document.deletedRanges };
    const screen = result.layout.screen;
    if (screen && (screen.sourceIdentity !== sourceIdentity || screen.inputFingerprint !== screenLayoutInputFingerprint({ ...binding, engineVersion: SCREEN_LAYOUT_ENGINE_VERSION }))) throw new ClipPreparationError("clip_preparation_input_invalid");
    if (screen && !("state" in screen) && (screen.sourceWidth !== (geometry.width || 1) || screen.sourceHeight !== (geometry.height || 1) ||
      Math.abs(screen.clipStartSec - timing.startSec) > 0.001 || Math.abs(screen.clipEndSec - timing.endSec) > 0.001 ||
      Math.abs(screen.sourceStartSec - timing.startSec) > 0.001 || Math.abs(screen.sourceDurationSec - (timing.endSec - timing.startSec)) > 0.001 ||
      digest(screen.deletedRanges) !== digest(input.document.deletedRanges))) throw new ClipPreparationError("clip_preparation_input_invalid");
    const split = result.layout.split;
    if (split && "state" in split && (split.sourceIdentity !== sourceIdentity || split.inputFingerprint !== splitLayoutInputFingerprint({ ...binding, engineVersion: "explicit-split-v1" }))) throw new ClipPreparationError("clip_preparation_input_invalid");
    return result;
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
    return this.inputForGroupIdentity(tx, { id: reference.subject.id, generation: reference.generation, deploymentEpoch: epoch.epoch });
  }

  private async inputForGroupIdentity(tx: Tx, identity: { id: string; generation: number; deploymentEpoch: number }, locked?: { group: RenderGroup; projectId: string }) {
    const epoch = { epoch: identity.deploymentEpoch }, reference = { subject: { id: identity.id }, generation: identity.generation };
    const initial = locked?.group ?? await tx.renderGroup.findUnique({ where: { id: reference.subject.id } });
    if (!initial) throw new ClipPreparationError("clip_preparation_input_invalid");
    if (!locked) {
      const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: initial.workflowRunId }, include: { project: true } });
      await lockWorkspaceUsage(tx, run.project.workspaceId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${run.projectId}, 0)) IS NULL AS locked`;
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${run.projectId}::uuid FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id = ${initial.workflowRunId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "RenderGroup" WHERE id = ${initial.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Clip" WHERE id = ${initial.clipId}::uuid FOR UPDATE`;
    const clock = await now(tx);
    const group = await tx.renderGroup.findUniqueOrThrow({ where: { id: initial.id }, include: { workflowRun: true, members: { orderBy: { clipRenderId: "asc" } } } });
    const project = await tx.project.findFirst({ where: { id: group.workflowRun.projectId, ...accessibleProjectWhere(clock), workspace: { status: "active" } } });
    const clip = await tx.clip.findFirst({ where: { id: group.clipId, projectId: group.workflowRun.projectId } });
    if (!project || !clip || (locked && project.id !== locked.projectId) || project.ingestStatus !== "ready" || !project.sourceStorageKey || group.deploymentEpoch !== epoch.epoch || group.generation !== reference.generation ||
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
    if (frozen && variants.some(variant => {
      const snapshot = variant.clipSnapshot as Record<string, unknown> | null;
      return !snapshot || snapshot.editorRevision !== configuration[2] || snapshot.wholeSource !== wholeSource || snapshot.llmModel !== llmModel ||
        digest(decodeFrozenClipEditorDocument(snapshot, probe.durationSec)) !== digest(document);
    })) throw new ClipPreparationError("clip_preparation_input_invalid");
    const base = { version: 1 as const, kind: "prepare_clip" as const, preparationId: "00000000-0000-0000-0000-000000000000", projectId: project.id, clipId: clip.id,
      sourceRevision: project.sourceRevision, editorRevision: configuration[2] as number, engineHash: this.dependencies.engineHash, toolchainFingerprint: this.dependencies.toolchainFingerprint,
      source: { storageKey: source.storageKey, etag: source.etag, byteLength: Number(source.byteLength), sha256: source.checksumSha256 }, sourceProbe: probe, document, wholeSource, llmModel };
    const bindingHash = await clipPreparationBinding(base);
    const id = clipPreparationIdentity(epoch.epoch, clip.id, bindingHash);
    if ((group.preparationId !== null && group.preparationId !== id) || (group.status === "running" && group.preparationId === null)) throw new ClipPreparationError("clip_preparation_input_invalid");
    const input: ClipPreparationInput = { ...base, preparationId: id, bindingHash };
    const groupDeadlineAt = group.operationDeadlineAt ?? new Date(clock.getTime() + deadlineMs);
    if (!group.operationDeadlineAt) await tx.renderGroup.update({ where: { id: group.id }, data: { operationDeadlineAt: groupDeadlineAt } });
    return { input, groupId: group.id, deploymentEpoch: epoch.epoch, clock, groupDeadlineAt };
  }

  /** Reuses the same source/editor/export validation without registering any
   * product permission while the proved restore remains fenced. */
  async restoreInputForGroup(tx: Tx, groupId: string, page: ExecutionRestorePage) {
    await assertExecutionRestorePage(tx,page);
    const group=await tx.renderGroup.findUniqueOrThrow({where:{id:groupId},select:{generation:true,deploymentEpoch:true}});
    if(group.deploymentEpoch!==page.deploymentEpoch)throw new ClipPreparationError("clip_preparation_input_invalid");
    return this.inputForGroupIdentity(tx,{id:groupId,generation:group.generation,deploymentEpoch:group.deploymentEpoch});
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
      if (frozen.groupDeadlineAt <= frozen.clock) throw new ClipPreparationError("clip_preparation_input_invalid");
      const existing = await tx.clipPreparation.findUnique({ where: { id: frozen.input.preparationId } });
      const key = `projects/${frozen.input.projectId}/preparations/${frozen.input.preparationId}/${crypto.randomUUID()}.json`;
      if (!existing) await admitMediaCleanupObligations(tx, [{ origin: "clip_preparation_input", cleanupClass: "execution_input", projectId: frozen.input.projectId,
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
        const existing = await tx.clipPreparation.findUnique({ where: { id: fresh.input.preparationId } });
        if (existing) return this.admission(tx, existing, fresh.groupId);
        await lockPlannedExecutionObject(tx, { origin: "clip_preparation_input", storageKey: key });
        const row = await tx.clipPreparation.upsert({ where: { id: fresh.input.preparationId }, update: {}, create: {
          id: fresh.input.preparationId, projectId: fresh.input.projectId, clipId: fresh.input.clipId, sourceRevision: fresh.input.sourceRevision, editorRevision: fresh.input.editorRevision,
          bindingHash: fresh.input.bindingHash, engineHash: fresh.input.engineHash, inputHash: clipPreparationExecutionInputHash(fresh.input.preparationId, fresh.input.bindingHash),
          inputStorageKey: key, inputEtag: stored.etag, inputByteLength: BigInt(stored.byteLength), inputChecksumSha256: stored.sha256,
          deploymentEpoch: fresh.deploymentEpoch, createdAt: fresh.clock, operationDeadlineAt: deadline,
        } });
        await tx.mediaCleanupObligation.updateMany({ where: { origin: "clip_preparation_input", cleanupClass: "execution_input", objectKey: row.inputStorageKey, completedAt: null },
          data: { nextAttemptAt: new Date(row.operationDeadlineAt.getTime() + 120_000) } });
        return this.admission(tx, row, fresh.groupId);
      });
    }
    try { await this.dependencies.register(result.dispatchIds); }
    catch(error) { if(error instanceof ExecutionDispatchPendingError)throw error; throw new ClipPreparationError("clip_preparation_unavailable", result.preparationId); }
    return result;
  }

  private async lockPreparation(tx: Tx, reference: ExecutionDispatchReference) {
    const record = await readExecutionDispatch(tx, reference.dispatchId);
    const [initial] = await tx.$queryRaw<Array<Pick<ClipPreparation, "id" | "projectId" | "inputHash" | "generation" | "deploymentEpoch"> & { workspaceId: string; currentEpoch: number }>>`
      SELECT preparation.id, preparation."projectId", preparation."inputHash", preparation.generation, preparation."deploymentEpoch", project."workspaceId", epoch.epoch AS "currentEpoch"
      FROM "ClipPreparation" preparation JOIN "Project" project ON project.id = preparation."projectId"
      CROSS JOIN "ExecutionEpoch" epoch WHERE preparation.id = ${reference.subject.id}::uuid AND epoch.id = 1`;
    if (reference.subject.kind !== "clip_preparation" || !["operation_driver", "modal_execution"].includes(reference.kind) || !initial || reference.deploymentEpoch !== initial.currentEpoch ||
      !record || JSON.stringify(record.reference) !== JSON.stringify(reference)) return null;
    if (initial.inputHash !== reference.inputHash || initial.generation !== reference.generation || initial.deploymentEpoch !== reference.deploymentEpoch) return null;
    await lockWorkspaceUsage(tx, initial.workspaceId);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${initial.projectId}, 0)) IS NULL AS locked`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${initial.projectId}::uuid FOR UPDATE`;
    const [job] = await tx.$queryRaw<ClipPreparation[]>`SELECT * FROM "ClipPreparation" WHERE id = ${initial.id}::uuid FOR UPDATE`;
    if (!job || job.inputHash !== reference.inputHash || job.generation !== reference.generation || job.deploymentEpoch !== reference.deploymentEpoch) return null;
    return { job, record };
  }

  private async currentInput(tx: Tx, job: ClipPreparation): Promise<ClipPreparationInput | null> {
    // Exports retain their snapshot while ordinary groups follow the live Clip.
    // Prefer an export when a later edit made an ordinary group obsolete.
    const groups = await tx.renderGroup.findMany({ where: { preparationId: job.id, deploymentEpoch: job.deploymentEpoch, status: { in: ["queued", "running"] },
      workflowRun: { projectId: job.projectId, status: { in: ["queued", "waiting"] } }, members: { some: { invalidatedAt: null } } }, orderBy: [{ exportIdentity: "desc" }, { id: "asc" }], take: 100 });
    for (const group of groups) {
      const base = await tx.executionDispatch.findFirst({ where: { deploymentEpoch: job.deploymentEpoch, kind: "operation_driver", subjectKind: "render_group", subjectId: group.id,
        generation: group.generation, wakeKind: null, deadlineKind: null }, select: { id: true } });
      if (!base) throw new ClipPreparationError("clip_preparation_unavailable", job.id);
      const record = await readExecutionDispatch(tx, base.id);
      try {
        if (record && (record.reference.kind !== "operation_driver" || record.reference.subject.kind !== "render_group" || record.reference.subject.id !== group.id ||
          record.reference.generation !== group.generation || record.reference.deploymentEpoch !== job.deploymentEpoch)) throw new ClipPreparationError("clip_preparation_input_invalid");
        // lockPreparation already holds the current epoch, Workspace and
        // Project authority. Keep this candidate's fresh row locks and reads,
        // without recursively rereading the same dispatch and parent locks.
        const state = record ? await this.inputForGroupIdentity(tx, { id: group.id, generation: group.generation, deploymentEpoch: job.deploymentEpoch }, { group, projectId: job.projectId }) : null;
        if (state?.input.preparationId === job.id && state.input.bindingHash === job.bindingHash && state.input.engineHash === job.engineHash) return state.input;
      } catch (error) {
        if (!(error instanceof ClipPreparationError && error.code === "clip_preparation_input_invalid")) throw error;
      }
    }
    return null;
  }

  private async revoke(tx: Tx, job: ClipPreparation, clock: Date, code: string) {
    if (!job.attemptToken) return;
    await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${job.attemptToken}::uuid FOR UPDATE`;
    await tx.executionAttempt.updateMany({ where: { attemptToken: job.attemptToken, deploymentEpoch: job.deploymentEpoch, generation: job.generation, inputHash: job.inputHash,
      status: { in: ["admitted", "running"] } }, data: { status: "superseded", revokedAt: clock, finishedAt: clock, failureCode: code } });
  }

  private async wakeGroups(tx: Tx, job: ClipPreparation, after?: string): Promise<string[]> {
    const groups = await tx.renderGroup.findMany({ where: { preparationId: job.id, deploymentEpoch: job.deploymentEpoch, status: { in: ["queued", "running"] }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" }, take: 101 });
    const page = groups.slice(0, 100);
    const bases = await tx.executionDispatch.findMany({ where: { deploymentEpoch: job.deploymentEpoch, kind: "operation_driver", subjectKind: "render_group", subjectId: { in: page.map(group => group.id) },
      wakeKind: null, deadlineKind: null }, select: { subjectId: true, generation: true, inputHash: true } });
    const byGroup = new Map(bases.map(base => [`${base.subjectId}:${base.generation}`, base]));
    const rows = await appendExecutionDispatches(tx, page.flatMap(group => {
      const base = byGroup.get(`${group.id}:${group.generation}`);
      if (!base) throw new ClipPreparationError("clip_preparation_unavailable", job.id);
      return [{ deploymentEpoch: group.deploymentEpoch, kind: "operation_driver" as const, subject: { kind: "render_group" as const, id: group.id }, generation: group.generation,
        inputHash: base.inputHash, dueAt: job.completedAt ?? job.createdAt, wakeKind: "preparation_outcome" }];
    }));
    const ids = rows.map(row => row.reference.dispatchId);
    if (groups.length > 100) ids.push((await appendExecutionDispatch(tx, { deploymentEpoch: job.deploymentEpoch, kind: "operation_driver", subject: { kind: "clip_preparation", id: job.id }, generation: job.generation,
      inputHash: job.inputHash, dueAt: job.completedAt ?? job.createdAt, wakeKind: `groups_${groups[99]!.id.replaceAll("-", "")}` })).reference.dispatchId);
    return ids;
  }

  async prepareExecution(value: ExecutionDispatchReference): Promise<ClipPreparationExecution> {
    const reference = executionDispatchReferenceSchema.parse(value);
    const result = await this.database.$transaction(async tx => {
      await tx.$queryRaw`SELECT epoch FROM "ExecutionEpoch" WHERE id = 1 FOR SHARE`;
      const state = reference.kind === "operation_driver" ? await this.lockPreparation(tx, reference) : null;
      if (!state) return { kind: "superseded" as const, dispatchIds: [] };
      const { job, record } = state;
      if (["completed", "failed", "superseded"].includes(job.status)) {
        const cursor = /^groups_([a-f0-9]{32})$/.exec(record.wakeKind ?? "")?.[1];
        const after = cursor ? `${cursor.slice(0, 8)}-${cursor.slice(8, 12)}-${cursor.slice(12, 16)}-${cursor.slice(16, 20)}-${cursor.slice(20)}` : undefined;
        return { kind: "terminal" as const, dispatchIds: await this.wakeGroups(tx, job, after) };
      }
      const input = await this.currentInput(tx, job), clock = await now(tx);
      if (!input) {
        await this.revoke(tx, job, clock, "clip_preparation_superseded");
        const ended = await tx.clipPreparation.update({ where: { id: job.id }, data: { status: "superseded", executorOwner: null, leaseExpiresAt: null, completedAt: clock, errorCode: "clip_preparation_superseded" } });
        return { kind: "superseded" as const, dispatchIds: await this.wakeGroups(tx, ended) };
      }
      if (job.operationDeadlineAt <= clock) return { kind: "terminal" as const, dispatchIds: (await this.finishFailure(tx, job, clock, "clip_preparation_deadline", false)).dispatchIds };
      if (job.retryAt && job.retryAt > clock) return { kind: "sleep" as const, dueAt: job.retryAt, dispatchIds: [] };
      const attemptToken = job.attemptToken ?? crypto.randomUUID();
      const native = await appendExecutionDispatch(tx, { deploymentEpoch: job.deploymentEpoch, kind: "modal_execution", subject: { kind: "clip_preparation", id: job.id }, generation: job.generation,
        inputHash: job.inputHash, dueAt: job.retryAt ?? job.createdAt });
      await tx.executionAttempt.upsert({ where: { attemptToken }, update: {}, create: { attemptToken, dispatchId: native.reference.dispatchId, deploymentEpoch: job.deploymentEpoch,
        generation: job.generation, inputHash: job.inputHash, functionName: "prepare_clip", operationDeadlineAt: job.operationDeadlineAt, inputStorageKey: job.inputStorageKey,
        inputEtag: job.inputEtag, inputByteLength: job.inputByteLength, inputChecksumSha256: job.inputChecksumSha256 } });
      if (!job.attemptToken) await tx.clipPreparation.update({ where: { id: job.id }, data: { attemptToken } });
      const until = job.leaseExpiresAt ?? job.operationDeadlineAt, kind = job.leaseExpiresAt ? "lease" as const : "operation" as const;
      const watchdog = await appendExecutionDispatch(tx, { deploymentEpoch: job.deploymentEpoch, kind: "operation_driver", subject: { kind: "clip_preparation", id: job.id }, generation: job.generation,
        inputHash: job.inputHash, dueAt: until, deadlineKind: kind, observedDeadlineAt: until });
      return { kind: "waiting" as const, deadline: { reference: native.reference, attemptToken, kind, observedDeadlineAt: until.toISOString() }, deliveryId: watchdog.reference.dispatchId,
        dispatchIds: [watchdog.reference.dispatchId, native.reference.dispatchId] };
    });
    await this.dependencies.register(result.dispatchIds);
    return result;
  }

  async lockExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string): Promise<ExecutorDomainLock<ClipPreparationExecutionReference>> {
    const state = reference.kind === "modal_execution" ? await this.lockPreparation(tx, reference) : null;
    if (!state || state.job.attemptToken !== attemptToken) return { kind: "terminal", disposition: { disposition: "superseded" } };
    const { job } = state;
    if (["completed", "failed", "superseded"].includes(job.status)) return { kind: "terminal", disposition: job.status === "failed" ? { disposition: "failed", failureCode: job.errorCode ?? "clip_preparation_failed" }
      : { disposition: job.status === "completed" ? "completed" : "superseded" }, dispatchIds: await this.wakeGroups(tx, job) };
    const input = await this.currentInput(tx, job);
    if (!input) {
      const clock = await now(tx);
      await this.revoke(tx, job, clock, "clip_preparation_superseded");
      const ended = await tx.clipPreparation.update({ where: { id: job.id }, data: { status: "superseded", executorOwner: null, leaseExpiresAt: null, completedAt: clock, errorCode: "clip_preparation_superseded" } });
      return { kind: "terminal", disposition: { disposition: "superseded" }, dispatchIds: await this.wakeGroups(tx, ended) };
    }
    return { kind: "current", ref: { id: job.id, attemptToken, input } };
  }

  private async owned(tx: Tx, ref: ClipPreparationExecutionReference, context: Omit<ExecutorMutationContext, "now">) {
    const clock = await now(tx);
    const job = await tx.clipPreparation.findFirst({ where: { id: ref.id, status: "running", attemptToken: context.attemptToken, executorOwner: context.owner,
      generation: context.reference.generation, deploymentEpoch: context.reference.deploymentEpoch, inputHash: context.reference.inputHash, leaseExpiresAt: { gt: clock }, operationDeadlineAt: { gt: clock } } });
    if (!job || ref.attemptToken !== context.attemptToken || context.functionName !== "prepare_clip" || context.reference.subject.kind !== "clip_preparation" || context.reference.subject.id !== ref.id ||
      ref.input.preparationId !== job.id || ref.input.bindingHash !== job.bindingHash) throw new ClipPreparationError("clip_preparation_input_invalid");
    return { job, clock };
  }

  async acquireExecution(tx: Tx, ref: ClipPreparationExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const clock = await now(tx), job = await tx.clipPreparation.findUniqueOrThrow({ where: { id: ref.id } });
    if (job.status !== "queued" || job.executorOwner || job.attemptToken !== context.attemptToken || job.chargedAttempts >= 3 || context.functionName !== "prepare_clip" ||
      job.operationDeadlineAt <= clock || job.operationDeadlineAt.getTime() !== context.operationDeadlineAt.getTime() || (job.retryAt && job.retryAt > clock) ||
      context.leaseExpiresAt <= clock || context.leaseExpiresAt > job.operationDeadlineAt) throw new ClipPreparationError("clip_preparation_input_invalid");
    await tx.clipPreparation.update({ where: { id: job.id }, data: { status: "running", executorOwner: context.owner, leaseExpiresAt: context.leaseExpiresAt, errorCode: null } });
    const wake = await appendExecutionDispatch(tx, { deploymentEpoch: job.deploymentEpoch, kind: "operation_driver", subject: { kind: "clip_preparation", id: job.id }, generation: job.generation,
      inputHash: job.inputHash, dueAt: clock, wakeKind: "preparation_acquired", deadlineKind: "lease", observedDeadlineAt: context.leaseExpiresAt });
    return { dispatchIds: [wake.reference.dispatchId] };
  }
  async renewExecution(tx: Tx, ref: ClipPreparationExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    await this.owned(tx, ref, context);
    await tx.clipPreparation.update({ where: { id: ref.id }, data: { leaseExpiresAt: context.leaseExpiresAt } });
    return undefined;
  }
  async startExecution(tx: Tx, ref: ClipPreparationExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const { job } = await this.owned(tx, ref, context);
    if (job.chargedAttempts >= 3) throw new ClipPreparationError("clip_preparation_input_invalid");
    await tx.clipPreparation.update({ where: { id: job.id }, data: { chargedAttempts: { increment: 1 } } });
    return undefined;
  }
  async progressExecution(tx: Tx, ref: ClipPreparationExecutionReference, context: ExecutorMutationContext, _progress: ExecutorProgressInput): Promise<ExecutorMutationResult> {
    await this.owned(tx, ref, context); return undefined;
  }

  private async finishFailure(tx: Tx, job: ClipPreparation, clock: Date, code: string, retryable: boolean): Promise<{ dispatchIds: string[] }> {
    const retry = retryable && job.chargedAttempts < 3 && clock < job.operationDeadlineAt;
    await this.revoke(tx, job, clock, code);
    const ended = await tx.clipPreparation.update({ where: { id: job.id }, data: { status: retry ? "queued" : "failed", generation: retry ? { increment: 1 } : undefined,
      attemptToken: retry ? null : job.attemptToken, executorOwner: null, leaseExpiresAt: null, result: Prisma.DbNull, errorCode: code,
      retryAt: retry ? new Date(Math.min(job.operationDeadlineAt.getTime(), clock.getTime() + 5000 * 2 ** job.chargedAttempts)) : null, completedAt: retry ? null : clock } });
    if (!retry) return { dispatchIds: await this.wakeGroups(tx, ended) };
    const registration = await appendExecutionDispatch(tx, { deploymentEpoch: ended.deploymentEpoch, kind: "operation_driver", subject: { kind: "clip_preparation", id: ended.id }, generation: ended.generation,
      inputHash: ended.inputHash, dueAt: ended.retryAt! });
    return { dispatchIds: [registration.reference.dispatchId] };
  }
  async failExecution(tx: Tx, ref: ClipPreparationExecutionReference, context: ExecutorMutationContext, failure: ExecutorFailureInput): Promise<ExecutorMutationResult> {
    const { job, clock } = await this.owned(tx, ref, context); return this.finishFailure(tx, job, clock, failure.failureCode, failure.retryable);
  }
  async releaseExecution(tx: Tx, ref: ClipPreparationExecutionReference, context: ExecutorMutationContext, release: ExecutorReleaseInput): Promise<ExecutorMutationResult> {
    const { job, clock } = await this.owned(tx, ref, context); return this.finishFailure(tx, job, clock, `clip_preparation_${release.reason}`, release.reason !== "cancelled");
  }
  async expireExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string, observation: ExecutorExpiryObservation): Promise<ExecutorExpiryResult> {
    const locked = await this.lockExecution(tx, reference, attemptToken);
    if (locked.kind === "terminal") return { kind: locked.disposition.disposition === "superseded" ? "superseded" : "terminal", dispatchIds: locked.dispatchIds };
    const job = await tx.clipPreparation.findUniqueOrThrow({ where: { id: locked.ref.id } }), clock = await now(tx);
    const due = observation.kind === "lease" ? job.leaseExpiresAt : job.operationDeadlineAt;
    if (!due || due.getTime() !== observation.observedDeadlineAt.getTime()) return { kind: "sleep", dueAt: new Date(Math.min(job.leaseExpiresAt?.getTime() ?? Infinity, job.operationDeadlineAt.getTime())) };
    if (due > clock) return { kind: "sleep", dueAt: due };
    return { kind: "expired", dispatchIds: (await this.finishFailure(tx, job, clock, "clip_preparation_deadline", observation.kind === "lease")).dispatchIds };
  }


  private object(row: ExecutionArtifact): ClipPreparationObject {
    if (!row.committedAt || !row.etag || !row.checksumSha256 || row.byteLength === null) throw new ClipPreparationError("clip_preparation_input_invalid");
    return { storageKey: row.storageKey, etag: row.etag, byteLength: Number(row.byteLength), sha256: row.checksumSha256 };
  }

  private async ready(tx: Tx, job: ClipPreparation, result: ClipPreparationResult, current?: { artifact: ClipPreparationArtifactCommit; clock: Date }): Promise<ReadyClipPreparation | null> {
    if (!job.attemptToken) throw new ClipPreparationError("clip_preparation_input_invalid");
    const attempt = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken: job.attemptToken }, select: { owner: true } });
    if (!attempt.owner) throw new ClipPreparationError("clip_preparation_input_invalid");
    const rows = await tx.executionArtifact.findMany({ where: { attemptToken: job.attemptToken, owner: attempt.owner, bindingHash: job.bindingHash,
      role: { in: ["clip_preview", "preview_peaks", "layout_evidence"] } } });
    if (current) {
      const row = rows.find(row => row.id === current.artifact.artifactId);
      if (!row) throw new ClipPreparationError("clip_preparation_input_invalid");
      Object.assign(row, { committedAt: current.clock, byteLength: current.artifact.byteLength, checksumSha256: current.artifact.sha256, etag: current.artifact.etag });
    }
    const preview = rows.find(row => row.id === result.preview.artifactId && row.role === "clip_preview");
    const peaksId = result.peaks.state === "ready" ? result.peaks.artifactId : null;
    const peaks = peaksId ? rows.find(row => row.id === peaksId && row.role === "preview_peaks") : null;
    const manifest = rows.find(row => row.role === "layout_evidence");
    if (!preview?.committedAt || !manifest?.committedAt || (peaksId && !peaks?.committedAt)) return null;
    if (preview.contentType !== "video/mp4" || manifest.contentType !== "application/json" || (peaks && (peaks.contentType !== "application/json" || peaks.storageKey !== derivePeaksStorageKey(preview.storageKey)))) throw new ClipPreparationError("clip_preparation_input_invalid");
    return { preparationId: job.id, bindingHash: job.bindingHash,
      input: { storageKey: job.inputStorageKey, etag: job.inputEtag, byteLength: Number(job.inputByteLength), sha256: job.inputChecksumSha256 },
      preview: this.object(preview), peaks: peaks ? this.object(peaks) : null, manifest: this.object(manifest), result };
  }

  async commitArtifactExecution(tx: Tx, ref: ClipPreparationExecutionReference, context: ExecutorMutationContext, artifact: ClipPreparationArtifactCommit): Promise<ExecutorMutationResult> {
    const { job, clock } = await this.owned(tx, ref, context);
    if (artifact.bindingHash !== job.bindingHash || !["clip_preview", "preview_peaks", "layout_evidence"].includes(artifact.role)) throw new ClipPreparationError("clip_preparation_input_invalid");
    const result = artifact.role === "layout_evidence" ? validateClipPreparationManifest(ref.input, artifact.result) : job.result === null ? null : validateClipPreparationManifest(ref.input, job.result as ClipPreparationResult);
    if (!result) return undefined;
    if (artifact.role === "layout_evidence") await tx.clipPreparation.update({ where: { id: job.id }, data: { result: result as Prisma.InputJsonValue } });
    const ready = await this.ready(tx, job, result, { artifact, clock });
    if (!ready) return undefined;
    const clip = await tx.clip.findUniqueOrThrow({ where: { id: job.clipId } });
    let liveDocument = null;
    try { liveDocument = decodeClipEditorDocumentFromStorage(clip, { durationSec: ref.input.sourceProbe.durationSec, wholeSource: clip.wholeSource }); }
    catch { /* A frozen export can finish without replacing corrupt/newer live editor state. */ }
    if (clip.editorRevision === job.editorRevision && clip.wholeSource === ref.input.wholeSource && clip.llmModel === ref.input.llmModel && liveDocument && digest(liveDocument) === digest(ref.input.document)) {
      await tx.clip.update({ where: { id: clip.id }, data: { previewStorageKey: ready.preview.storageKey, previewStartSec: result.preview.startSec, previewDurationSec: result.preview.durationSec,
        autoLayoutAnalysis: result.layout.automatic && !("state" in result.layout.automatic) ? result.layout.automatic as Prisma.InputJsonValue : Prisma.DbNull,
        layoutAnalysis: result.layout.screen as Prisma.InputJsonValue ?? Prisma.DbNull, splitLayoutAnalysis: result.layout.split as Prisma.InputJsonValue ?? Prisma.DbNull,
        autoLayoutStatus: "completed", autoLayoutClaimToken: null, autoLayoutLeaseExpiresAt: null } });
    }
    const completed = await tx.clipPreparation.update({ where: { id: job.id }, data: { status: "completed", completedAt: clock, executorOwner: null, leaseExpiresAt: null,
      errorCode: null, retryAt: null, result: result as Prisma.InputJsonValue, readyObjects: clipPreparationReadyObjectsSchema.parse({ preview: ready.preview, peaks: ready.peaks, manifest: ready.manifest }) as Prisma.InputJsonValue } });
    return { dispatchIds: await this.wakeGroups(tx, completed) };
  }

  /** Kept inside the current command scope; only private object references and
   * metadata leave the Workflow handler, never this layout/caption payload. */
  async readReadyForGroup(reference: ExecutionDispatchReference): Promise<ReadyClipPreparation | null> {
    return this.database.$transaction(async tx => {
      const state = await this.inputForGroup(tx, executionDispatchReferenceSchema.parse(reference));
      const job = await tx.clipPreparation.findUnique({ where: { id: state.input.preparationId } });
      if (!job || job.status !== "completed" || job.result === null) return null;
      const result = validateClipPreparationManifest(state.input, job.result as ClipPreparationResult);
      const objects = clipPreparationReadyObjectsSchema.safeParse(job.readyObjects);
      if (!objects.success || (result.peaks.state === "ready") !== (objects.data.peaks !== null)) throw new ClipPreparationError("clip_preparation_input_invalid");
      return { preparationId: job.id, bindingHash: job.bindingHash, input: { storageKey: job.inputStorageKey, etag: job.inputEtag,
        byteLength: Number(job.inputByteLength), sha256: job.inputChecksumSha256 }, ...objects.data, result };

    });
  }

  /** Consume only the input freshly validated by lockExecution in this same
   * authority transaction. No capsule/provider I/O or second authority lookup. */
  async workInputWithinAuthority(tx: Tx, authority: ExecutorLiveAuthority, ref: ClipPreparationExecutionReference) {
    const fence = authority.fence;
    await this.owned(tx, ref, { ...fence, reference: fence.reference, leaseExpiresAt: authority.leaseExpiresAt,
      operationDeadlineAt: authority.operationDeadlineAt, functionName: authority.functionName });
    return { inputHash: fence.reference.inputHash, source: ref.input.source, outputs: [
      { role: "clip_preview" as const, bindingHash: ref.input.bindingHash, contentType: "video/mp4", maxBytes: 512 * 1024 ** 2 },
      { role: "preview_peaks" as const, bindingHash: ref.input.bindingHash, contentType: "application/json", maxBytes: 256 * 1024 },
      { role: "layout_evidence" as const, bindingHash: ref.input.bindingHash, contentType: "application/json", maxBytes: 1024 ** 2 },
    ] };
  }
}
