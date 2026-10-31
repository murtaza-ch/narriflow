import { randomUUID } from "node:crypto";
import type { ClipDub, WorkflowRun, ExecutionAttempt, ExecutionArtifact, Prisma, PrismaClient } from "@prisma/client";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { frozenDubbingRequestSchema, dubbingCheckpointSchema, type DubbingCheckpoint } from "@narriflow/validators/dubbing-execution";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { WorkflowRunLifecycle, type WorkflowExecutionReference } from "./workflow-run-lifecycle";
import { readExecutionDispatch, appendExecutionDispatch, executionDispatchIdentity } from "./execution-dispatch";
import { takeExecutionDispatchIds, collectExecutionDispatch } from "./execution-dispatch-runtime";
import { lockWorkspaceUsage } from "./processing-usage";
import { lockGenerationUsage, releaseGenerationUsage } from "./generated-media-usage-ledger";
import { frozenDubbingRequestHash, dubTranslationRequestBody, dubSpeechRequestBody, dubbingArtifactBindingHash, shouldTranslateDub, DUBBING_STAGE_OUTPUTS, type DubbingArtifactStage } from "./dubbing-policy";
import { dubbingInputBinding, encodeDubbingInput, decodeDubbingInput } from "./dubbing-input";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { lockPlannedExecutionObject } from "./execution-object-cleanup";
import { flushWorkspaceEvents } from "./workspace-event";
import type { PrivateJsonObject, PrivateJsonStorage } from "./private-json-storage";
import type { NativeValidationPreparation } from "./native-validation";
import type { DubbingExecutionInput } from "@narriflow/validators/dubbing-execution";
import { createExecutorControl, ExecutorControlError, type ExecutorArtifactHead } from "./executor-control";
import { createExecutionTransfer } from "./execution-transfer";
import type { createExecutionStorage } from "./execution-storage";
import type { ExecutorArtifactCommit, ExecutorDomainLock, ExecutorMutationContext, ExecutorMutationResult, ExecutorFailureInput, ExecutorReleaseInput, ExecutorExpiryObservation, ExecutorExpiryResult } from "./executor-domain-control";
import { WorkflowFailure } from "./workflow-attempt-contract";
import { appendWorkflowEvent } from "./workflow-event-append";
import { flushProjectProgressDrains } from "./progress-outbox";

type Tx = Prisma.TransactionClient;
interface Dependencies {
  toolchainFingerprint: string;
  inputStorage: Pick<PrivateJsonStorage, "read" | "write">;
  head(storageKey: string): Promise<DubbingExecutionInput["baseVideo"] | null>;
  register(ids: readonly string[]): Promise<void>;
}
export interface DubbingArtifactCommit extends ExecutorArtifactCommit { input?: DubbingExecutionInput; evidence?: DubbingCheckpoint }
function tuple(row: Pick<ClipDub | ExecutionAttempt, "inputStorageKey" | "inputEtag" | "inputByteLength" | "inputChecksumSha256">): PrivateJsonObject {
  if (!row.inputStorageKey || !row.inputEtag || !row.inputByteLength || !row.inputChecksumSha256) throw Error("dubbing_input_invalid");
  return { storageKey: row.inputStorageKey, etag: row.inputEtag, byteLength: Number(row.inputByteLength), sha256: row.inputChecksumSha256 };
}
async function checkpointObject(database: Pick<Tx, "executionArtifact">, id: string, requestHash: string, stage: DubbingArtifactStage, workflowRunId: string) {
  const row = await database.executionArtifact.findUnique({ where: { id }, include: { attempt: { select: { functionName: true, deploymentEpoch: true, attemptToken: true, dispatch: { select: { subjectKind: true, subjectId: true } } } } } });
  const policy = DUBBING_STAGE_OUTPUTS[stage];
  if (!row?.committedAt || row.role !== policy.role || row.contentType !== policy.contentType || row.bindingHash !== await dubbingArtifactBindingHash(requestHash, stage) || !row.etag || !row.byteLength || !row.checksumSha256 ||
    row.byteLength > BigInt(policy.maxBytes) || row.attempt.functionName !== "dub_mix" || row.attempt.dispatch.subjectKind !== "workflow_run" || row.attempt.dispatch.subjectId !== workflowRunId ||
    !row.storageKey.startsWith(`execution/${row.attempt.deploymentEpoch}/${row.attempt.attemptToken}/${row.owner}/`)) throw new ExecutorControlError("artifact_invalid");
  return { storageKey: row.storageKey, etag: row.etag, byteLength: Number(row.byteLength), sha256: row.checksumSha256 };
}

/** The accepted Workflow Run owns every lease, generation and charged start.
 * Paid stages and final publication share its fresh authority. */
export class DubbingExecution extends WorkflowRunLifecycle {
  constructor(private readonly database: PrismaClient, private readonly dubbingDependencies: Dependencies) {
    super({ prisma: database });
    if (!/^[a-f0-9]{64}$/.test(dubbingDependencies.toolchainFingerprint)) throw Error("dubbing_configuration_invalid");
  }
  private async transition<T>(operation: (tx: Tx) => Promise<T>) {
    const result = await this.database.$transaction(async tx => {
      const value = await operation(tx);await flushWorkspaceEvents(tx);
      const returned = value && typeof value === "object" && "dispatchIds" in value && Array.isArray(value.dispatchIds) ? value.dispatchIds as string[] : [];
      return { value, dispatchIds: [...new Set([...returned, ...await flushProjectProgressDrains(tx), ...takeExecutionDispatchIds(tx)])] };
    });
    if (result.dispatchIds.length) await this.dubbingDependencies.register(result.dispatchIds);
    return result.value;
  }
  private async current(tx: Tx, reference: ExecutionDispatchReference, verifySources = true) {
    const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT epoch FROM "ExecutionEpoch" WHERE id=1 FOR SHARE`;
    const record = await readExecutionDispatch(tx, reference.dispatchId);
    if (!epoch || epoch.epoch !== reference.deploymentEpoch || reference.subject.kind !== "workflow_run" || !["operation_driver", "modal_execution"].includes(reference.kind) ||
      !record || JSON.stringify(record.reference) !== JSON.stringify(reference)) return null;
    const initial = await tx.workflowRun.findUnique({ where: { id: reference.subject.id }, include: { project: { select: { workspaceId: true } } } });
    if (!initial || initial.stage !== "dubbing") return null;
    await lockWorkspaceUsage(tx, initial.project.workspaceId);await lockGenerationUsage(tx, initial.project.workspaceId);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${initial.projectId},0)) IS NULL AS locked`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${initial.projectId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${initial.id}::uuid FOR UPDATE`;
    const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: initial.id } });
    if (run.generation !== reference.generation || run.deploymentEpoch !== reference.deploymentEpoch) return null;
    await tx.$queryRaw`SELECT id FROM "ClipDub" WHERE "workflowRunId"=${initial.id}::uuid FOR UPDATE`;
    const dub = await tx.clipDub.findUnique({ where: { workflowRunId: run.id } });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    if (!dub || !clock || dub.projectId !== run.projectId || dub.deploymentEpoch !== run.deploymentEpoch || !dub.frozenRequest || !dub.requestHash || !dub.operationDeadlineAt || !["queued", "processing"].includes(dub.status)) return null;
    const request = frozenDubbingRequestSchema.parse(dub.frozenRequest);
    if (request.dubId !== dub.id || request.workflowRunId !== run.id || request.projectId !== run.projectId || request.clipId !== dub.clipId ||
      request.voice !== dub.voice || request.targetLanguageCode !== dub.targetLanguageCode || request.model !== dub.model || request.provider !== dub.provider || await frozenDubbingRequestHash(request) !== dub.requestHash) throw Error("dubbing_request_invalid");
    const accepted = { run, dub, request, now: clock.now, deadlineAt: dub.operationDeadlineAt };
    const authority = await super.lockExecution(tx, reference, run.attemptId ?? reference.dispatchId);
    if (authority.kind !== "current") {
      if (["failed", "cancelled", "superseded"].includes(authority.disposition.disposition)) await this.finishAccepted(tx, accepted, reference,
        run.errorCode ?? (authority.disposition.disposition === "superseded" ? "dubbing_source_superseded" : "dubbing_parent_failed"));
      return null;
    }
    if (verifySources) {
      const project = await tx.project.findUniqueOrThrow({ where: { id: run.projectId }, select: { sourceRevision: true, workspaceId: true } });
      const workspace = await tx.workspace.findUnique({ where: { id: request.workspaceId }, select: { status: true, ownerUserId: true } });
      const actor = await tx.user.findUnique({ where: { id: request.actorUserId }, select: { deletedAt: true } });
      const membership = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: request.workspaceId, userId: request.actorUserId } }, select: { role: true } });
      const owner = workspace?.ownerUserId === request.actorUserId;
      const clip = await tx.clip.findUnique({ where: { id: request.clipId }, select: { projectId: true, editorRevision: true } });
      const render = await tx.clipRender.findUnique({ where: { id: request.baseRender.id }, select: { clipId: true, status: true, storageKey: true, sizeBytes: true } });
      const reason = !workspace || !actor || actor.deletedAt || !owner && !membership || !workspaceAllowsCapability({ role: owner ? "owner" : membership!.role, status: workspace.status }, "processing.consume") ? "dubbing_access_revoked"
        : project.workspaceId !== request.workspaceId || project.sourceRevision !== request.sourceRevision ? "dubbing_source_superseded"
        : !clip || clip.projectId !== run.projectId || clip.editorRevision !== request.editorRevision ? "dubbing_clip_superseded"
        : !render || render.clipId !== request.clipId || render.status !== "completed" || render.storageKey !== request.baseRender.storageKey || render.sizeBytes !== BigInt(request.baseRender.byteLength) ? "dubbing_render_unavailable" : null;
      if (reason) { await this.finishAccepted(tx, accepted, reference, reason);return null; }
    }
    return accepted;
  }
  async loadInput(row: Pick<ClipDub | ExecutionAttempt, "inputStorageKey" | "inputEtag" | "inputByteLength" | "inputChecksumSha256">) {
    const object = tuple(row), input = await decodeDubbingInput(await this.dubbingDependencies.inputStorage.read(object), object);
    if (input.toolchainFingerprint !== this.dubbingDependencies.toolchainFingerprint) throw Error("dubbing_runtime_invalid");
    return input;
  }
  override async lockExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string): Promise<ExecutorDomainLock<WorkflowExecutionReference>> {
    const state = await this.current(tx, reference);
    const locked = await super.lockExecution(tx, reference, attemptToken);
    if (locked.kind !== "current") return { ...locked, dispatchIds: await this.finishedWakes(tx, reference) };
    if (!state || locked.ref.stage !== "dubbing") return { kind: "terminal", disposition: { disposition: "superseded" } };
    const attempt = await tx.executionAttempt.findUnique({ where: { attemptToken } });
    if (!attempt || attempt.functionName !== "dub_mix" || attempt.dispatchId !== reference.dispatchId || attempt.operationDeadlineAt.getTime() !== state.deadlineAt.getTime() ||
      attempt.inputStorageKey !== state.dub.inputStorageKey || attempt.inputEtag !== state.dub.inputEtag || attempt.inputByteLength !== state.dub.inputByteLength || attempt.inputChecksumSha256 !== state.dub.inputChecksumSha256 || !state.dub.inputBindingHash) throw new ExecutorControlError("invalid_reference");
    return locked;
  }
  private async owned(tx: Tx, ref: WorkflowExecutionReference, context: ExecutorMutationContext) {
    const state = await this.current(tx, context.reference);
    if (!state || ref.id !== state.run.id || ref.attemptToken !== context.attemptToken || state.run.status !== "running" || state.run.attemptId !== context.attemptToken ||
      state.run.leaseOwner !== context.owner || !state.run.leaseExpiresAt || state.run.leaseExpiresAt <= state.now || state.deadlineAt <= state.now || context.functionName !== "dub_mix") throw new ExecutorControlError("authority_lost");
    return state;
  }
  private outstanding(dub: Pick<ClipDub, "translationIntentArtifactId" | "translationResultArtifactId" | "speechIntentArtifactId" | "audioArtifactId">) {
    return dub.translationIntentArtifactId !== null && dub.translationResultArtifactId === null || dub.speechIntentArtifactId !== null && dub.audioArtifactId === null;
  }
  override async acquireExecution(tx: Tx, ref: WorkflowExecutionReference, context: ExecutorMutationContext): Promise<ExecutorMutationResult> {
    const result = await super.acquireExecution(tx, ref, context), state = await this.owned(tx, ref, context);
    const owner = new WorkflowRunLifecycle({ prisma: this.database, leaseOwner: context.owner });
    const marked = await owner.markDubProcessingWithinTransaction(tx, { workflowRunId: ref.id, projectId: ref.projectId, stage: "dubbing", attemptId: context.attemptToken, attemptCount: state.run.attemptCount }, state.dub.id);
    if (marked.count !== 1) throw new ExecutorControlError("authority_lost");
    return result;
  }
  override async commitArtifactExecution(tx: Tx, ref: WorkflowExecutionReference, context: ExecutorMutationContext, artifact: DubbingArtifactCommit): Promise<ExecutorMutationResult> {
    const state = await this.owned(tx, ref, context), input = artifact.input, evidence = artifact.evidence;
    if (!input || input.requestHash !== state.dub.requestHash || input.bindingHash !== state.dub.inputBindingHash || input.request.dubId !== state.dub.id) throw new ExecutorControlError("artifact_invalid");
    if (artifact.role === "dub_mix") {
      const stage = artifact.contentType === "audio/mpeg" ? "audio" : artifact.contentType === "video/mp4" ? "video" : null;
      if (!stage || artifact.bindingHash !== await dubbingArtifactBindingHash(input.requestHash, stage) || artifact.byteLength > BigInt(DUBBING_STAGE_OUTPUTS[stage].maxBytes) ||
        !state.dub.speechIntentArtifactId || !state.dub.translationResultArtifactId || !state.dub.translatedText) throw new ExecutorControlError("artifact_invalid");
      if (stage === "audio") {
        if (state.dub.audioArtifactId) throw new ExecutorControlError("artifact_invalid");
        await checkpointObject(tx, state.dub.speechIntentArtifactId, input.requestHash, "speech_intent", state.run.id);
        await tx.clipDub.update({ where: { id: state.dub.id }, data: { audioArtifactId: artifact.artifactId } });
      } else {
        if (!state.dub.audioArtifactId || state.dub.videoArtifactId) throw new ExecutorControlError("artifact_invalid");
        await checkpointObject(tx, state.dub.audioArtifactId, input.requestHash, "audio", state.run.id);
        await tx.clipDub.update({ where: { id: state.dub.id }, data: { videoArtifactId: artifact.artifactId } });
      }
      return undefined;
    }
    if (!evidence || artifact.role !== "probe" || artifact.contentType !== "application/json" || artifact.byteLength > BigInt(DUBBING_STAGE_OUTPUTS[evidence.stage].maxBytes) ||
      evidence.dubId !== state.dub.id || evidence.requestHash !== state.dub.requestHash || artifact.bindingHash !== await dubbingArtifactBindingHash(input.requestHash, evidence.stage)) throw new ExecutorControlError("artifact_invalid");
    const translated = shouldTranslateDub(state.request.sourceLanguageCode, state.request.targetLanguageCode);
    if (evidence.stage === "translation_intent") {
      if (!translated || state.dub.translationIntentArtifactId || state.dub.translationResultArtifactId) throw new ExecutorControlError("artifact_invalid");
      const body = new TextEncoder().encode(JSON.stringify(dubTranslationRequestBody(state.request)));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), byte => byte.toString(16).padStart(2, "0")).join("");
      if (evidence.bodySha256 !== hash) throw new ExecutorControlError("artifact_invalid");
      await tx.clipDub.update({ where: { id: state.dub.id }, data: { translationIntentArtifactId: artifact.artifactId } });
    } else if (evidence.stage === "translation_result") {
      if (state.dub.translationResultArtifactId) throw new ExecutorControlError("artifact_invalid");
      if (translated) {
        if (!state.dub.translationIntentArtifactId) throw new ExecutorControlError("artifact_invalid");
        await checkpointObject(tx, state.dub.translationIntentArtifactId, input.requestHash, "translation_intent", state.run.id);
      } else if (state.dub.translationIntentArtifactId || evidence.text !== state.request.script || evidence.providerRequestId !== null) throw new ExecutorControlError("artifact_invalid");
      await tx.clipDub.update({ where: { id: state.dub.id }, data: { translationResultArtifactId: artifact.artifactId, translatedText: evidence.text } });
    } else if (evidence.stage === "speech_intent") {
      if (!state.dub.translationResultArtifactId || !state.dub.translatedText || state.dub.speechIntentArtifactId || state.dub.audioArtifactId) throw new ExecutorControlError("artifact_invalid");
      await checkpointObject(tx, state.dub.translationResultArtifactId, input.requestHash, "translation_result", state.run.id);
      const body = new TextEncoder().encode(JSON.stringify(dubSpeechRequestBody(state.request, state.dub.translatedText)));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), byte => byte.toString(16).padStart(2, "0")).join("");
      if (evidence.bodySha256 !== hash) throw new ExecutorControlError("artifact_invalid");
      await tx.clipDub.update({ where: { id: state.dub.id }, data: { speechIntentArtifactId: artifact.artifactId } });
    } else {
      if (evidence.outcome !== "completed") {
        const intentId = evidence.providerStage === "translation" ? state.dub.translationIntentArtifactId : state.dub.speechIntentArtifactId;
        const resultId = evidence.providerStage === "translation" ? state.dub.translationResultArtifactId : state.dub.audioArtifactId;
        if (!intentId || resultId || state.dub.outcomeArtifactId) throw new ExecutorControlError("artifact_invalid");
        await checkpointObject(tx, intentId, input.requestHash, evidence.providerStage === "translation" ? "translation_intent" : "speech_intent", state.run.id);
        const unknown = evidence.outcome === "unknown", code = unknown ? "dub_provider_outcome_unknown" : "dub_provider_rejected";
        await tx.clipDub.update({ where: { id: state.dub.id }, data: { status: unknown ? "unknown" : "failed", errorCode: code, completedAt: state.now, outcomeArtifactId: artifact.artifactId } });
        return super.failExecution(tx, ref, context, { failureCode: code, retryable: false });
      }
      if (this.outstanding(state.dub) || !state.dub.audioArtifactId || !state.dub.videoArtifactId || !state.dub.translationResultArtifactId || !state.dub.translatedText || state.dub.outcomeArtifactId) throw new ExecutorControlError("artifact_invalid");
      const audio = await checkpointObject(tx, state.dub.audioArtifactId, input.requestHash, "audio", state.run.id), video = await checkpointObject(tx, state.dub.videoArtifactId, input.requestHash, "video", state.run.id);
      if (audio.byteLength !== evidence.audio.byteLength || audio.sha256 !== evidence.audio.sha256 || video.byteLength !== evidence.video.byteLength || video.sha256 !== evidence.video.sha256) throw new ExecutorControlError("artifact_invalid");
      await tx.clipDub.update({ where: { id: state.dub.id }, data: { outcomeArtifactId: artifact.artifactId } });
      const owner = new WorkflowRunLifecycle({ prisma: this.database, leaseOwner: context.owner });
      const completed = await owner.completeDubWithinTransaction(tx, { workflowRunId: ref.id, projectId: ref.projectId, stage: "dubbing", attemptId: context.attemptToken, attemptCount: state.run.attemptCount }, state.dub.id,
        { status: "completed", transcriptText: state.request.script, translatedText: state.dub.translatedText, audioStorageKey: audio.storageKey, renderStorageKey: video.storageKey,
          audioSizeBytes: BigInt(audio.byteLength), renderSizeBytes: BigInt(video.byteLength), durationSec: evidence.probe.state === "ready" ? evidence.probe.durationSec : null,
          model: state.request.model, errorCode: null, completedAt: state.now });
      if (completed.count !== 1) throw new ExecutorControlError("authority_lost");
      return this.completeExecutionWithinTransaction(tx, ref, context, { requestedCount: 1, succeededCount: 1, failedCount: 0 });
    }
    return undefined;
  }
  override async failExecution(tx: Tx, ref: WorkflowExecutionReference, context: ExecutorMutationContext, failure: ExecutorFailureInput): Promise<ExecutorMutationResult> {
    const state = await this.owned(tx, ref, context);
    if (this.outstanding(state.dub)) {
      await tx.clipDub.update({ where: { id: state.dub.id }, data: { status: "unknown", errorCode: "dub_provider_outcome_unknown", completedAt: state.now } });
      return super.failExecution(tx, ref, context, { failureCode: "dub_provider_outcome_unknown", retryable: false });
    }
    return super.failExecution(tx, ref, context, failure);
  }
  override async releaseExecution(tx: Tx, ref: WorkflowExecutionReference, context: ExecutorMutationContext, release: ExecutorReleaseInput): Promise<ExecutorMutationResult> {
    const state = await this.owned(tx, ref, context);
    if (this.outstanding(state.dub)) {
      await tx.clipDub.update({ where: { id: state.dub.id }, data: { status: "unknown", errorCode: "dub_provider_outcome_unknown", completedAt: state.now } });
      return super.failExecution(tx, ref, context, { failureCode: "dub_provider_outcome_unknown", retryable: false });
    }
    return super.releaseExecution(tx, ref, context, release);
  }
  override async expireExecution(tx: Tx, reference: ExecutionDispatchReference, attemptToken: string, observation: ExecutorExpiryObservation): Promise<ExecutorExpiryResult> {
    const attempt = await tx.executionAttempt.findUnique({ where: { attemptToken } });
    if (!attempt || attempt.functionName !== "dub_mix" || attempt.dispatchId !== reference.dispatchId || attempt.deploymentEpoch !== reference.deploymentEpoch || attempt.generation !== reference.generation ||
      attempt.inputHash !== reference.inputHash || !Number.isFinite(observation.observedDeadlineAt.getTime()) || observation.kind === "operation" && observation.observedDeadlineAt.getTime() !== attempt.operationDeadlineAt.getTime()) return { kind: "superseded" };
    const state = await this.current(tx, reference, false);
    if (state && this.outstanding(state.dub) && state.run.status === "running" && state.run.attemptId === attemptToken && state.run.leaseOwner && state.run.leaseExpiresAt &&
      Math.min(state.run.leaseExpiresAt.getTime(), state.deadlineAt.getTime()) <= state.now.getTime()) {
      await tx.clipDub.update({ where: { id: state.dub.id }, data: { status: "unknown", errorCode: "dub_provider_outcome_unknown", completedAt: state.now } });
      await new WorkflowRunLifecycle({ prisma: this.database, leaseOwner: state.run.leaseOwner }).failAttemptWithinTransaction(tx,
        { workflowRunId: state.run.id, projectId: state.run.projectId, stage: "dubbing", attemptId: attemptToken, attemptCount: state.run.attemptCount },
        new WorkflowFailure("dub_provider_outcome_unknown", "permanent", "Dubbing outcome needs review"), { expiredLeaseOnly: true });
      const wake = await appendExecutionDispatch(tx, { ...reference, kind: "operation_driver", dueAt: state.now, wakeKind: "execution_finished" });
      collectExecutionDispatch(tx, wake.reference.dispatchId);return { kind: "expired", dispatchIds: [wake.reference.dispatchId] };
    }
    return super.expireExecution(tx, reference, attemptToken, observation);
  }
  private async finishedWakes(tx: Tx, reference: ExecutionDispatchReference) {
    return (await tx.executionDispatch.findMany({ where: { deploymentEpoch: reference.deploymentEpoch, generation: reference.generation, inputHash: reference.inputHash,
      subjectKind: "workflow_run", subjectId: reference.subject.id, kind: "operation_driver", wakeKind: "execution_finished" }, select: { id: true }, take: 1 })).map(row => row.id);
  }
  private async failUnowned(tx: Tx, state: { run: WorkflowRun; dub: ClipDub; now: Date }, reference: ExecutionDispatchReference, reason: string) {
    if (state.run.status !== "queued" || state.run.attemptId || state.run.leaseOwner || state.run.leaseExpiresAt) throw new ExecutorControlError("authority_lost");
    return this.finishAccepted(tx, state, reference, reason);
  }
  private async finishAccepted(tx: Tx, state: { run: WorkflowRun; dub: ClipDub; now: Date }, reference: ExecutionDispatchReference, reason: string) {
    const ambiguous = this.outstanding(state.dub), code = ambiguous ? "dub_provider_outcome_unknown" : reason;
    await tx.clipDub.update({ where: { id: state.dub.id }, data: { status: ambiguous ? "unknown" : "failed", errorCode: code, completedAt: state.now } });
    if (!ambiguous) await releaseGenerationUsage(tx, { kind: "dub", jobIds: [state.dub.id], reason: code });
    await tx.workflowRun.update({ where: { id: state.run.id }, data: { status: state.run.status === "cancelled" ? "cancelled" : "failed", progress: 100, errorCode: code, requestedCount: 1, succeededCount: 0, failedCount: 1,
      leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null, nextPollAt: null } });
    await appendWorkflowEvent(tx, { workflowRunId: state.run.id, projectId: state.run.projectId, attemptId: state.run.attemptId ?? state.dub.workflowAttemptId ?? state.dub.id,
      stage: "dubbing", status: "failed", progress: 100, errorCode: code, transition: "terminal:failed", analyticsRequired: true }, { progressRequired: true, analyticsEnabled: true });
    const wake = await appendExecutionDispatch(tx, { ...reference, kind: "operation_driver", dueAt: state.now, wakeKind: "execution_finished" });
    collectExecutionDispatch(tx, wake.reference.dispatchId);return { dispatchIds: [wake.reference.dispatchId] };
  }
  async expirePreparationDeadline(reference: ExecutionDispatchReference, observation: ExecutorExpiryObservation): Promise<ExecutorExpiryResult | { kind: "native"; attemptToken: string }> {
    return this.transition(async tx => {
      const record = await readExecutionDispatch(tx, reference.dispatchId);
      if (reference.kind !== "operation_driver" || reference.subject.kind !== "workflow_run" || observation.kind !== "operation" || record?.deadlineKind !== "operation" ||
        JSON.stringify(record.reference) !== JSON.stringify(reference) || record.observedDeadlineAt?.getTime() !== observation.observedDeadlineAt.getTime()) return { kind: "superseded" };
      const state = await this.current(tx, reference, false);
      if (!state) {
        const run = await tx.workflowRun.findUnique({ where: { id: reference.subject.id } });
        if (!run || run.generation !== reference.generation || run.deploymentEpoch !== reference.deploymentEpoch || !["completed", "partial", "failed", "cancelled"].includes(run.status)) return { kind: "superseded" };
        const wakes = await tx.executionDispatch.findMany({ where: { deploymentEpoch: reference.deploymentEpoch, generation: reference.generation, inputHash: reference.inputHash,
          subjectKind: "workflow_run", subjectId: run.id, kind: "operation_driver", wakeKind: "execution_finished" }, select: { id: true }, take: 1 });
        return { kind: "terminal", dispatchIds: wakes.map(row => row.id) };
      }
      if (state.deadlineAt.getTime() !== observation.observedDeadlineAt.getTime()) return { kind: "superseded" };
      if (state.run.status === "running") return state.run.attemptId && state.run.leaseOwner && state.run.leaseExpiresAt ? { kind: "native", attemptToken: state.run.attemptId } : { kind: "superseded" };
      if (state.run.status !== "queued" || state.run.attemptId || state.run.leaseOwner || state.run.leaseExpiresAt) return { kind: "superseded" };
      if (state.deadlineAt > state.now) return { kind: "sleep", dueAt: state.deadlineAt };
      return { kind: "expired", ...await this.failUnowned(tx, state, reference, "operation_deadline_exceeded") };
    });
  }
  async prepareExecution(reference: ExecutionDispatchReference): Promise<NativeValidationPreparation> {
    const initial = await this.transition(async tx => {
      const state = await this.current(tx, reference, false);if (!state) return null;
      const watch = await appendExecutionDispatch(tx, { ...reference, dueAt: state.deadlineAt, deadlineKind: "operation", observedDeadlineAt: state.deadlineAt });
      if (!state.run.operationDeadlineAt) await tx.workflowRun.update({ where: { id: state.run.id }, data: { operationDeadlineAt: state.deadlineAt } });
      else if (state.run.operationDeadlineAt.getTime() !== state.deadlineAt.getTime()) throw Error("dubbing_deadline_invalid");
      return { ...state, watch };
    });
    if (!initial) return { kind: "superseded" };
    await this.dubbingDependencies.register([initial.watch.reference.dispatchId]);
    if (initial.run.status === "queued" && !initial.run.attemptId && this.outstanding(initial.dub)) {
      await this.transition(async tx => { const state = await this.current(tx, reference, false);if (state) await this.failUnowned(tx, state, reference, "dub_provider_outcome_unknown"); });
      return { kind: "terminal" };
    }
    if (initial.deadlineAt <= initial.now) {
      const expired = await this.expirePreparationDeadline(initial.watch.reference, { kind: "operation", observedDeadlineAt: initial.deadlineAt });
      if (expired.kind === "native") {
        const attempt = await this.database.executionAttempt.findUnique({ where: { attemptToken: expired.attemptToken } });
        const native = attempt ? await readExecutionDispatch(this.database, attempt.dispatchId) : null;
        if (!attempt || !native || attempt.functionName !== "dub_mix" || attempt.operationDeadlineAt.getTime() !== initial.deadlineAt.getTime() || native.reference.subject.id !== reference.subject.id ||
          native.reference.generation !== reference.generation || native.reference.deploymentEpoch !== reference.deploymentEpoch || native.reference.inputHash !== reference.inputHash) throw new ExecutorControlError("invalid_reference");
        return { kind: "waiting", deadline: { reference: native.reference, attemptToken: attempt.attemptToken, kind: "operation", observedDeadlineAt: attempt.operationDeadlineAt.toISOString() }, deliveryId: initial.watch.reference.dispatchId, dispatchIds: [initial.watch.reference.dispatchId] };
      }
      return { kind: expired.kind === "superseded" ? "superseded" : "terminal" };
    }
    if (initial.run.nextAttemptAt && initial.run.nextAttemptAt > initial.now) return { kind: "sleep", dueAt: new Date(Math.min(initial.run.nextAttemptAt.getTime(), initial.deadlineAt.getTime())) };
    if (!initial.dub.inputStorageKey) {
      const source = await this.transition(tx => this.current(tx, reference));if (!source) return { kind: "superseded" };
      const baseVideo = await this.dubbingDependencies.head(source.request.baseRender.storageKey);
      if (!baseVideo || baseVideo.storageKey !== source.request.baseRender.storageKey || baseVideo.byteLength !== source.request.baseRender.byteLength) throw Error("dubbing_source_changed");
      const value = { version: 1 as const, kind: "dub_mix" as const, request: source.request, requestHash: source.dub.requestHash!, toolchainFingerprint: this.dubbingDependencies.toolchainFingerprint, baseVideo };
      const encoded = await encodeDubbingInput({ ...value, bindingHash: await dubbingInputBinding(value) });
      const key = await this.transition(async tx => {
        const state = await this.current(tx, reference);if (!state) return null;if (state.dub.inputStorageKey) return null;
        if (state.deadlineAt <= state.now) return null;
        const key = `projects/${state.run.projectId}/dubs/${state.dub.id}/${randomUUID()}.json`;
        await admitMediaCleanupObligations(tx, [{ origin: "dubbing_input", cleanupClass: "execution_input", projectId: state.run.projectId, objectKey: key, notBefore: new Date(state.deadlineAt.getTime() + 120_000) }]);
        return key;
      });
      if (key) {
        const stored = await this.dubbingDependencies.inputStorage.write(key, encoded.bytes);
        if (stored.byteLength !== encoded.byteLength || stored.sha256 !== encoded.sha256 || stored.etag.length > 160 || !/^"[^\r\n"]+"$/.test(stored.etag)) throw Error("dubbing_input_invalid");
        await this.transition(async tx => {
          const state = await this.current(tx, reference);if (!state || state.dub.inputStorageKey || state.deadlineAt <= state.now) return;
          await lockPlannedExecutionObject(tx, { origin: "dubbing_input", storageKey: key });
          await tx.clipDub.update({ where: { id: state.dub.id }, data: { inputBindingHash: encoded.input.bindingHash, inputStorageKey: key, inputEtag: stored.etag, inputByteLength: BigInt(stored.byteLength), inputChecksumSha256: stored.sha256 } });
        });
      }
    }
    const prepared = await this.transition(async tx => {
      const state = await this.current(tx, reference);if (!state || state.deadlineAt <= state.now) return null;
      const object = tuple(state.dub), identity = { deploymentEpoch: reference.deploymentEpoch, generation: reference.generation, kind: "modal_execution" as const, subject: reference.subject };
      const key = await executionDispatchIdentity(identity), prior = await tx.executionDispatch.findUnique({ where: { deliveryKey: key.deliveryKey }, select: { dueAt: true } });
      const native = await appendExecutionDispatch(tx, { ...identity, inputHash: reference.inputHash, dueAt: prior?.dueAt ?? state.run.nextAttemptAt ?? state.run.createdAt });
      const attempts = await tx.executionAttempt.findMany({ where: { dispatchId: native.reference.dispatchId }, take: 2 });
      if (attempts.length > 1) throw Error("dubbing_attempt_invalid");
      const attempt = attempts[0] ?? await tx.executionAttempt.create({ data: { attemptToken: randomUUID(), dispatchId: native.reference.dispatchId, deploymentEpoch: reference.deploymentEpoch,
        generation: reference.generation, inputHash: reference.inputHash, functionName: "dub_mix", operationDeadlineAt: state.deadlineAt, inputStorageKey: object.storageKey, inputEtag: object.etag, inputByteLength: BigInt(object.byteLength), inputChecksumSha256: object.sha256 } });
      if (attempt.functionName !== "dub_mix" || attempt.operationDeadlineAt.getTime() !== state.deadlineAt.getTime() || attempt.inputStorageKey !== object.storageKey || attempt.inputEtag !== object.etag || attempt.inputByteLength !== BigInt(object.byteLength) || attempt.inputChecksumSha256 !== object.sha256 || state.run.status === "running" && state.run.attemptId !== attempt.attemptToken) throw Error("dubbing_attempt_invalid");
      return { kind: "waiting" as const, deadline: { reference: native.reference, attemptToken: attempt.attemptToken, kind: "operation" as const, observedDeadlineAt: state.deadlineAt.toISOString() }, deliveryId: initial.watch.reference.dispatchId, dispatchIds: [initial.watch.reference.dispatchId, native.reference.dispatchId] };
    });
    if (!prepared) return { kind: "terminal" };
    await this.dubbingDependencies.register(prepared.dispatchIds);return prepared;
  }
}

/** Scoped transfer and typed artifact publication for the accepted Dub. */
export function createDubbingExecution(options: { database: PrismaClient; domain: DubbingExecution; storage: ReturnType<typeof createExecutionStorage>;
  artifacts: { head(assignment: Readonly<ExecutionArtifact>): Promise<ExecutorArtifactHead | null>; readJson(artifact: ExecutorArtifactCommit, maxBytes: number): Promise<unknown> };
  deliverWakes(ids: readonly string[]): Promise<void> }) {
  const control = createExecutorControl({ database: options.database, subjectKind: "workflow_run", domain: options.domain, deliverWakes: options.deliverWakes,
    prepareContext: async attempt => { const input = await options.domain.loadInput(attempt);return { source: input.requestHash, analysis: null, toolchain: input.toolchainFingerprint }; },
    artifacts: { head: options.artifacts.head, prepare: async (assignment, artifact): Promise<DubbingArtifactCommit> => {
      const attempt = await options.database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: assignment.attemptToken } });
      const input = await options.domain.loadInput(attempt);
      if (artifact.role === "dub_mix") return { ...artifact, input };
      if (artifact.role !== "probe" || artifact.byteLength > 1024n ** 2n) throw new ExecutorControlError("artifact_invalid");
      const evidence = dubbingCheckpointSchema.safeParse(await options.artifacts.readJson(artifact, 1024 ** 2));if (!evidence.success) throw new ExecutorControlError("artifact_invalid");
      return { ...artifact, evidence: evidence.data, input };
    } } });
  const transfer = createExecutionTransfer({ database: options.database, authority: control, storage: options.storage, resolvePackage: async authority => {
    if (authority.functionName !== "dub_mix" || authority.fence.reference.kind !== "modal_execution" || authority.fence.reference.subject.kind !== "workflow_run" || !authority.input) throw new ExecutorControlError("invalid_reference");
    const input = await options.domain.loadInput({ inputStorageKey: authority.input.storageKey, inputEtag: authority.input.etag, inputByteLength: authority.input.byteLength, inputChecksumSha256: authority.input.sha256 });
    if (input.request.workflowRunId !== authority.fence.reference.subject.id) throw new ExecutorControlError("invalid_reference");
    const row = await options.database.clipDub.findUniqueOrThrow({ where: { id: input.request.dubId } });
    if (row.workflowRunId !== input.request.workflowRunId || row.requestHash !== input.requestHash) throw new ExecutorControlError("invalid_reference");
    const sources = [{ name: "base_video", ...input.baseVideo }];
    if (row.translationResultArtifactId) sources.push({ name: "translation_result", ...await checkpointObject(options.database, row.translationResultArtifactId, input.requestHash, "translation_result", input.request.workflowRunId) });
    if (row.audioArtifactId) sources.push({ name: "dub_audio", ...await checkpointObject(options.database, row.audioArtifactId, input.requestHash, "audio", input.request.workflowRunId) });
    if (row.videoArtifactId) sources.push({ name: "dub_video", ...await checkpointObject(options.database, row.videoArtifactId, input.requestHash, "video", input.request.workflowRunId) });
    const stages: DubbingArtifactStage[] = [];
    if (!row.translationIntentArtifactId && !row.translationResultArtifactId && shouldTranslateDub(input.request.sourceLanguageCode, input.request.targetLanguageCode)) stages.push("translation_intent");
    if (!row.translationResultArtifactId) stages.push("translation_result");
    if (!row.speechIntentArtifactId && !row.audioArtifactId) stages.push("speech_intent");
    if (!row.audioArtifactId) stages.push("audio");
    if (!row.videoArtifactId) stages.push("video");
    if (!row.outcomeArtifactId) stages.push("final_result");
    return { input: { kind: "object" }, sources, outputs: await Promise.all(stages.map(async stage => ({ ...DUBBING_STAGE_OUTPUTS[stage], bindingHash: await dubbingArtifactBindingHash(input.requestHash, stage) }))) };
  } });
  return { control, transfer };
}
