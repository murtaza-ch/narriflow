import type { ExecutionArtifact, Prisma, PrismaClient } from "@prisma/client";
import { executorFenceSchema, sourceLanguageProbeInputSchema, executionDispatchReferenceSchema, providerAttemptReferenceSchema, type ExecutionDispatchReference,
  type SourceLanguageProbeInput, type ProviderAttemptReference } from "@narriflow/validators/execution";
import { parseStoredContentPack, planTranscript, sourceProbeSchema, toProviderLanguageCode } from "@narriflow/validators";
import { appendExecutionDispatch, readExecutionDispatch, executionDispatchIdentity } from "./execution-dispatch";
import { LANGUAGE_PROBE_MAX_BYTES, selectProbeWindows } from "./language-probe-contract";
import { workflowRunExecutionInputHash } from "./workflow-execution-input";
import { lockWorkspaceUsage } from "./processing-usage";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import type { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { databaseNow } from "./execution-clock";

type Tx = Prisma.TransactionClient;
type Fence = ReturnType<typeof executorFenceSchema.parse>;
export interface SourceLanguageProbeDescriptor {
  output: { role: "probe"; bindingHash: string; contentType: "audio/wav"; maxBytes: number };
  input: SourceLanguageProbeInput;
}
export type TranscriptionProbePreparation =
  | { kind: "skip" | "unavailable"; reason: string; dispatchIds: string[] }
  | { kind: "wait"; dueAt: Date; dispatchIds: string[] }
  | { kind: "ready"; artifactId: string; dispatchIds: string[] };

type Target = { kind: "workflow"; reference: ExecutionDispatchReference } | { kind: "ingest"; fence: Fence };
type State = { kind: "skip" | "unavailable"; reason: string } | {
  kind: "eligible"; descriptor: SourceLanguageProbeDescriptor; workflowReference: ExecutionDispatchReference;
  artifact: ExecutionArtifact | null; active: boolean; now: Date;
};

function same(left: ExecutionDispatchReference, right: ExecutionDispatchReference) {
  return left.dispatchId === right.dispatchId && left.kind === right.kind && left.subject.kind === right.subject.kind && left.subject.id === right.subject.id &&
    left.deploymentEpoch === right.deploymentEpoch && left.generation === right.generation && left.inputHash === right.inputHash;
}

async function probeState(tx: Tx, target: Target, provider?: ProviderAttemptReference): Promise<State> {
  const reference = target.kind === "workflow" ? target.reference : target.fence.reference;
  const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
  const ledger = await readExecutionDispatch(tx, reference.dispatchId);
  if (epoch?.epoch !== reference.deploymentEpoch || !ledger || !same(ledger.reference, reference)) return { kind: "unavailable", reason: "superseded" };
  if (target.kind === "workflow" ? reference.kind !== "operation_driver" || reference.subject.kind !== "workflow_run" : reference.subject.kind !== "ingest_job") return { kind: "unavailable", reason: "superseded" };
  const initialRun = target.kind === "workflow" ? await tx.workflowRun.findUnique({ where: { id: reference.subject.id } }) : null;
  const initialJob = target.kind === "ingest" ? await tx.ingestJob.findUnique({ where: { id: reference.subject.id } }) : null;
  const projectId = initialRun?.projectId ?? initialJob?.projectId;
  if (!projectId) return { kind: "unavailable", reason: "superseded" };
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  await lockWorkspaceUsage(tx, project.workspaceId);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0)) IS NULL AS "locked"`;
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId}::uuid FOR UPDATE`;
  const candidates = target.kind === "ingest" ? (initialJob ? [initialJob] : []) :
    await tx.ingestJob.findMany({ where: { projectId, generationRunId: initialRun!.id }, orderBy: { createdAt: "desc" }, take: 2 });
  if (candidates.length !== 1) return { kind: "unavailable", reason: "source_owner_unavailable" };
  await tx.$queryRaw`SELECT "id" FROM "IngestJob" WHERE "id" = ${candidates[0]!.id}::uuid FOR UPDATE`;
  const job = await tx.ingestJob.findUniqueOrThrow({ where: { id: candidates[0]!.id } });
  if (!job.generationRunId) return { kind: "unavailable", reason: "setup_not_committed" };
  await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${job.generationRunId}::uuid FOR UPDATE`;
  const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: job.generationRunId } });
  const currentProject = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  if (currentProject.ingestStatus === "failed" || run.stage !== "stt" || run.projectId !== projectId || run.deploymentEpoch !== reference.deploymentEpoch ||
    job.deploymentEpoch !== reference.deploymentEpoch || job.sourceRevision !== currentProject.sourceRevision) return { kind: "unavailable", reason: "superseded" };
  if (run.status !== "queued" && run.status !== "waiting") return { kind: "skip", reason: "stage_not_queued" };
  if (run.status === "waiting" && target.kind === "workflow" && !provider) return { kind: "skip", reason: "provider_intent_exists" };
  const transcript = await tx.transcript.findUnique({ where: { projectId } });
  if (!transcript?.sourceAudioId || transcript.sourceRevision !== currentProject.sourceRevision) return { kind: "unavailable", reason: "source_audio_pending" };
  const registration = await tx.executionDispatch.findFirst({ where: { deploymentEpoch: run.deploymentEpoch, subjectKind: "workflow_run", subjectId: run.id,
    generation: run.generation, kind: "operation_driver", wakeKind: null, deadlineKind: null }, orderBy: { createdAt: "asc" } });
  const expectedHash = await workflowRunExecutionInputHash({ id: run.id, projectId, stage: run.stage, contentPackId: run.contentPackId, generation: run.generation,
    deploymentEpoch: run.deploymentEpoch, sourceAudioId: transcript.sourceAudioId, sourceRevision: transcript.sourceRevision });
  if (!registration || registration.inputHash !== expectedHash || (target.kind === "workflow" && (run.id !== reference.subject.id || run.generation !== reference.generation || reference.inputHash !== expectedHash))) return { kind: "unavailable", reason: "superseded" };
  if (provider) {
    const history = await tx.executionAttempt.findUnique({ where: { attemptToken: provider.attemptId }, include: { dispatch: true } });
    if (run.status !== "waiting" || run.attemptId !== provider.attemptId || provider.deploymentEpoch !== run.deploymentEpoch || provider.sourceAudioId !== transcript.sourceAudioId ||
      provider.sourceRevision !== transcript.sourceRevision || !history || history.status !== "completed" || !history.revokedAt || history.functionName !== "stt" ||
      history.inputHash !== expectedHash || history.generation !== run.generation || history.deploymentEpoch !== run.deploymentEpoch ||
      history.dispatch.subjectKind !== "workflow_run" || history.dispatch.subjectId !== run.id) return { kind: "unavailable", reason: "superseded" };
  }
  const pack = run.contentPackId ? await tx.contentPack.findFirst({ where: { id: run.contentPackId, projectId, draft: false } }) : null;
  if (run.contentPackId && !pack) return { kind: "unavailable", reason: "setup_not_committed" };
  const probe = sourceProbeSchema.safeParse(currentProject.sourceProbe);
  if (toProviderLanguageCode(currentProject.languageCode)) return { kind: "skip", reason: "explicit_language" };
  if (planTranscript({ captionedVideo: pack ? parseStoredContentPack(pack).captionedVideo : undefined, sourceProbe: probe.success ? probe.data : null }).kind !== "speech_to_text") return { kind: "skip", reason: "speech_not_required" };
  const audio = await tx.sourceAudio.findFirst({ where: { id: transcript.sourceAudioId, projectId, sourceRevision: transcript.sourceRevision } });
  if (!audio) return { kind: "unavailable", reason: "source_audio_pending" };
  const windows = selectProbeWindows(audio.durationSeconds);
  if (!windows || !job.operationDeadlineAt) return { kind: "unavailable", reason: windows ? "source_owner_unavailable" : "source_too_short" };
  const input = sourceLanguageProbeInputSchema.parse({ sourceAudioId: audio.id, sourceBindingHash: audio.bindingHash, workflowRunId: run.id, generation: run.generation,
    windows, toolchainFingerprint: audio.toolchainFingerprint, deadlineAt: new Date(Math.min(audio.createdAt.getTime() + 90_000, job.operationDeadlineAt.getTime())).toISOString() });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["language_probe_v1", input.sourceAudioId, input.sourceBindingHash,
    input.workflowRunId, input.generation, input.windows, input.toolchainFingerprint, input.deadlineAt])));
  const bindingHash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  const descriptor: SourceLanguageProbeDescriptor = { input, output: { role: "probe", bindingHash, contentType: "audio/wav", maxBytes: LANGUAGE_PROBE_MAX_BYTES } };
  const artifact = await tx.executionArtifact.findFirst({ where: { role: "probe", bindingHash, contentType: "audio/wav", committedAt: { not: null },
    attempt: { deploymentEpoch: reference.deploymentEpoch, dispatch: { subjectKind: "ingest_job", subjectId: job.id } } }, orderBy: [{ committedAt: "asc" }, { id: "asc" }] });
  const now = await databaseNow(tx);
  let active = false;
  if (job.status === "running" && job.claimId && job.executorOwner && job.claimExpiresAt && job.claimExpiresAt > now) {
    const token = executorFenceSchema.shape.attemptToken.safeParse(job.claimId);
    if (token.success) {
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${token.data}::uuid FOR UPDATE`;
      const owner = await tx.executionAttempt.findUnique({ where: { attemptToken: token.data }, include: { dispatch: true } });
      active = !!owner && owner.owner === job.executorOwner && owner.status === "running" && !owner.revokedAt && !!owner.processStartedAt &&
        !!owner.leaseExpiresAt && owner.leaseExpiresAt > now && owner.operationDeadlineAt > now && owner.functionName === "fetch_source" &&
        owner.deploymentEpoch === job.deploymentEpoch && owner.generation === job.generation && owner.dispatch.subjectKind === "ingest_job" && owner.dispatch.subjectId === job.id;
      if (target.kind === "ingest") active = active && target.fence.attemptToken === token.data && target.fence.owner === job.executorOwner &&
        target.fence.reference.generation === job.generation && owner?.dispatchId === target.fence.reference.dispatchId && owner?.inputHash === target.fence.reference.inputHash;
    }
  }
  return { kind: "eligible", descriptor, artifact, active, now, workflowReference: (await readExecutionDispatch(tx, registration.id))!.reference };
}

/** Called only after the Ingest domain has fenced the live owner in this transaction. */
export async function commitSourceLanguageProbeWithinTransaction(tx: Tx, fence: Fence, artifact: ExecutorArtifactCommit): Promise<{ dispatchIds: string[] }> {
  const state = await probeState(tx, { kind: "ingest", fence });
  if (state.kind !== "eligible" || !state.active || artifact.role !== "probe" || artifact.bindingHash !== state.descriptor.output.bindingHash ||
    artifact.contentType !== "audio/wav" || artifact.byteLength < 44n || artifact.byteLength > BigInt(LANGUAGE_PROBE_MAX_BYTES)) throw new Error("source_language_probe_invalid");
  const identity = { deploymentEpoch: state.workflowReference.deploymentEpoch, kind: "operation_driver" as const, subject: state.workflowReference.subject,
    generation: state.workflowReference.generation, wakeKind: "probe_ready" };
  const prior = await tx.executionDispatch.findUnique({ where: { deliveryKey: (await executionDispatchIdentity(identity)).deliveryKey }, select: { dueAt: true } });
  const wake = await appendExecutionDispatch(tx, { ...identity, inputHash: state.workflowReference.inputHash, dueAt: prior?.dueAt ?? state.now });
  return { dispatchIds: [wake.reference.dispatchId] };
}

export function createTranscriptionProbe(input: { database: PrismaClient; workflow: WorkflowRunLifecycle }) {
  async function transaction<T>(body: (tx: Tx) => Promise<T>) { return input.database.$transaction(body, { maxWait: 10_000, timeout: 30_000 }); }
  return {
    async readForProvider(value: ProviderAttemptReference): Promise<{ artifact: ExecutionArtifact; input: SourceLanguageProbeInput } | null> {
      const key = providerAttemptReferenceSchema.parse(value);
      return transaction(async tx => {
        const run = await tx.workflowRun.findUnique({ where: { id: key.workflowRunId }, select: { generation: true } });
        if (!run) return null;
        const registration = await tx.executionDispatch.findFirst({ where: { deploymentEpoch: key.deploymentEpoch, subjectKind: "workflow_run", subjectId: key.workflowRunId,
          generation: run.generation, kind: "operation_driver", wakeKind: null, deadlineKind: null }, select: { id: true } });
        if (!registration) return null;
        const reference = (await readExecutionDispatch(tx, registration.id))!.reference;
        const state = await probeState(tx, { kind: "workflow", reference }, key);
        const artifact = state.kind === "eligible" ? state.artifact : null;
        return state.kind === "eligible" && artifact?.committedAt && artifact.committedAt <= new Date(state.descriptor.input.deadlineAt) && artifact.byteLength &&
          artifact.byteLength >= 44n && artifact.byteLength <= BigInt(LANGUAGE_PROBE_MAX_BYTES) && artifact.checksumSha256 && artifact.etag ? { artifact, input: state.descriptor.input } : null;
      });
    },
    async descriptorForIngest(value: Fence): Promise<SourceLanguageProbeDescriptor | null> {
      const fence = executorFenceSchema.parse(value);
      return transaction(async tx => {
        const state = await probeState(tx, { kind: "ingest", fence });
        return state.kind === "eligible" && state.active && !state.artifact && state.now < new Date(state.descriptor.input.deadlineAt) ? state.descriptor : null;
      });
    },
    async prepare(value: ExecutionDispatchReference): Promise<TranscriptionProbePreparation> {
      const reference = executionDispatchReferenceSchema.parse(value);
      return transaction(async tx => {
        const state = await probeState(tx, { kind: "workflow", reference });
        if (state.kind !== "eligible") return { ...state, dispatchIds: [] };
        const dueAt = new Date(state.descriptor.input.deadlineAt);
        if (state.artifact?.committedAt && state.artifact.committedAt <= dueAt && state.artifact.byteLength && state.artifact.byteLength >= 44n &&
          state.artifact.byteLength <= BigInt(LANGUAGE_PROBE_MAX_BYTES) && state.artifact.checksumSha256 && state.artifact.etag) return { kind: "ready", artifactId: state.artifact.id, dispatchIds: [] };
        if (!state.active || dueAt <= state.now) return { kind: "unavailable", reason: state.active ? "probe_deadline_elapsed" : "source_owner_ended", dispatchIds: [] };
        const wake = await appendExecutionDispatch(tx, { deploymentEpoch: reference.deploymentEpoch, kind: "operation_driver", subject: reference.subject,
          generation: reference.generation, inputHash: reference.inputHash, dueAt, wakeKind: "probe_deadline", deadlineKind: "retry", observedDeadlineAt: dueAt });
        return { kind: "wait", dueAt, dispatchIds: [wake.reference.dispatchId] };
      });
    },
  };
}
