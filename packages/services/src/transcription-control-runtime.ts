import { getPrismaClient } from "@narriflow/db/client";
import { readServiceEnvironment } from "./runtime-environment";
import { getWorkflowRunLifecycle, WorkflowFailure } from "./workflow-run-lifecycle";
import { createTranscriptionAdmission } from "./transcription-admission";
import { createScribeProvider } from "./transcription-provider";
import { createTranscriptionControl, type TranscriptionControlPorts } from "./transcription-control";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { finalizeScribeTranscript } from "./scribe-transcript-runtime";
import { presignDownloadUrl } from "./r2-storage";
import { workflowRunExecutionInputHash } from "./workflow-execution-input";
import { createTranscriptionProbe } from "./transcription-probe";
import { readObjectBytes } from "./r2-storage";
import { LANGUAGE_PROBE_MAX_BYTES } from "./language-probe-contract";

/** Fresh within the invocation. Neither a service nor a read URL crosses a sleep. */
export function getTranscriptionControl(options: { probeLanguage?: TranscriptionControlPorts["probeLanguage"] } = {}) {
  const database = getPrismaClient();
  if (!database) throw new Error("Transcription requires a database scope");
  const workflow = getWorkflowRunLifecycle(), settings = readServiceEnvironment();
  const probe = createTranscriptionProbe({ database, workflow });
  const provider = () => createScribeProvider({ apiKey: settings.ELEVENLABS_API_KEY ?? "", webhookId: settings.ELEVENLABS_WEBHOOK_ID ?? "" });
  return createTranscriptionControl({
    admission: createTranscriptionAdmission({ database, workflow, maxUnits: Number(settings.SCRIBE_MAX_CONCURRENT_UNITS) }), workflow,
    provider, prepareProbe: reference => probe.prepare(reference),
    sourceAudioGrant: async (reference, expiresAt) => {
      const state = await workflow.readProviderControl(reference);
      if (state.kind !== "waiting" || !reference.sourceAudioId) throw new WorkflowFailure("source_audio_pending", "retryable", "Source Audio is unavailable");
      const history = await database.executionAttempt.findUnique({ where: { attemptToken: reference.attemptId }, include: { dispatch: true } });
      const run = await database.workflowRun.findUniqueOrThrow({ where: { id: reference.workflowRunId } });
      const audio = await database.sourceAudio.findFirst({ where: { id: reference.sourceAudioId, projectId: state.attempt.projectId, sourceRevision: reference.sourceRevision } });
      if (!audio || !history || history.functionName !== "stt" || history.status !== "completed" || !history.revokedAt ||
        history.dispatch.subjectKind !== "workflow_run" || history.dispatch.subjectId !== run.id || history.deploymentEpoch !== reference.deploymentEpoch || history.generation !== run.generation ||
        history.inputHash !== await workflowRunExecutionInputHash({ id: run.id, projectId: run.projectId, stage: run.stage, contentPackId: run.contentPackId,
          deploymentEpoch: run.deploymentEpoch, generation: run.generation, sourceAudioId: audio.id, sourceRevision: audio.sourceRevision })) throw new WorkflowFailure("source_audio_unverified", "permanent", "Source Audio is unverified");
      const artifact = await database.executionArtifact.findUnique({ where: { storageKey: audio.storageKey } });
      if (!artifact || artifact.role !== "source_audio" || !artifact.committedAt || artifact.etag !== audio.etag || artifact.byteLength !== audio.byteLength ||
        artifact.checksumSha256 !== audio.checksumSha256 || artifact.grantExpiresAt < expiresAt || !state.submittedAt ||
        expiresAt.getTime() !== state.submittedAt.getTime() + 4 * 60 * 60_000 || audio.byteLength > 2n * 1024n ** 3n) throw new WorkflowFailure("source_audio_unverified", "permanent", "Source Audio is unverified");
      const signedAt = Date.now(), seconds = Math.floor((expiresAt.getTime() - signedAt) / 1000);
      if (seconds <= 0 || expiresAt <= state.serverTime) throw new WorkflowFailure("source_audio_grant_expired", "retryable", "Source Audio read grant expired");
      const url = await presignDownloadUrl({ key: audio.storageKey, expiresIn: seconds });
      return { sourceAudioId: audio.id, url, expiresAt: new Date(signedAt + seconds * 1000) };
    },
    probeLanguage: options.probeLanguage ?? (async (reference, signal) => {
      const prepared = await probe.readForProvider(reference);
      if (!prepared) return { pinned: null, reason: "probe_unavailable" };
      const wav = await readObjectBytes(prepared.artifact.storageKey, LANGUAGE_PROBE_MAX_BYTES, { signal });
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(wav))), byte => byte.toString(16).padStart(2, "0")).join("");
      if (BigInt(wav.byteLength) !== prepared.artifact.byteLength || digest !== prepared.artifact.checksumSha256) return { pinned: null, reason: "probe_invalid" };
      return provider().probe({ wav, signal });
    }),
    finalize: finalizeScribeTranscript, deliverWakes: deliverExecutionDispatches,
  });
}
