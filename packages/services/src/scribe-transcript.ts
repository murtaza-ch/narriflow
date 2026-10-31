import {
  TranscriptNormalizationError,
  normalizeElevenLabsTranscript,
  type NormalizedTranscript,
} from "./transcript.service";
import {
  WorkflowFailure,
  type CompleteTranscriptInput,
  type ProviderAttemptReference,
  type ProviderAttemptLookup,
  type ProviderIds,
  type ProviderSettlementResult,
} from "./workflow-run-lifecycle";

export interface ScribeFinalizerDependencies {
  lifecycle: {
    lookupProviderAttempt(key: ProviderAttemptReference, ids?: ProviderIds): Promise<ProviderAttemptLookup>;
    completeProviderTranscript(key: ProviderAttemptReference, input: CompleteTranscriptInput): Promise<ProviderSettlementResult>;
    failProviderAttempt(key: ProviderAttemptReference, failure: WorkflowFailure, ids?: ProviderIds): Promise<ProviderSettlementResult>;
  };
  allowsEmptyTranscript(workflowRunId: string): Promise<boolean>;
  /** The source's exact probed duration, or null when unknown. */
  sourceDurationSeconds(input: { projectId: string; sourceAudioId: string | null; sourceRevision: number }): Promise<number | null>;
  storeRawJson(input: { key: string; value: unknown; metadata: Record<string, string> }): Promise<void>;
}

export interface FinalizeScribeTranscriptInput {
  key: ProviderAttemptReference;
  /** The Scribe transcript object: the GET body, or the webhook's `data.transcription`. */
  payload: unknown;
  providerIds: ProviderIds;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Content addressing prevents a stale racing delivery from replacing published evidence. */
export async function scribeRawStorageKey(projectId: string, key: ProviderAttemptReference, ids: ProviderIds, payload: unknown): Promise<string> {
  const [providerHash, payloadHash] = await Promise.all([sha256([ids.requestId ?? null, ids.transcriptionId ?? null]), sha256(payload)]);
  return `projects/${projectId}/transcripts/${key.deploymentEpoch}/${key.sourceRevision}/${key.workflowRunId}-${key.attemptId}/${providerHash}-${payloadHash}.json`;
}

function providerJobIdOf(payload: unknown): string | null {
  const id = (payload as { transcription_id?: unknown } | null)?.transcription_id;
  return typeof id === "string" && id ? id : null;
}

/**
 * Settles a waiting transcript from a Scribe result. The signed webhook and the
 * worker's GET recovery both call it. A duplicate, stale or terminal delivery
 * returns its settlement without touching storage or the transcript; a result
 * that cannot be normalized fails the attempt permanently.
 */
export function createScribeFinalizer(deps: ScribeFinalizerDependencies) {
  return async function finalizeScribeTranscript(
    input: FinalizeScribeTranscriptInput,
  ): Promise<ProviderSettlementResult> {
    const { key, payload, providerIds } = input;
    const lookup = await deps.lifecycle.lookupProviderAttempt(key, providerIds);
    if (lookup.kind !== "waiting") return lookup;

    const { projectId } = lookup.attempt;
    // An id this delivery omits (the documented webhook has no nested
    // transcription id; a GET has no request id) is the one acceptance recorded.
    const providerJobId = providerIds.transcriptionId ?? providerJobIdOf(payload) ?? lookup.providerJobId;
    const providerRequestId = providerIds.requestId ?? lookup.providerRequestId;
    const rawStorageKey = await scribeRawStorageKey(projectId, key, { requestId: providerRequestId, transcriptionId: providerJobId }, payload);

    // The raw result is kept even when it turns out unusable: it is the evidence.
    await deps.storeRawJson({
      key: rawStorageKey,
      value: payload,
      metadata: {
        project_id: projectId,
        workflow_run_id: key.workflowRunId,
        attempt_id: key.attemptId,
        deployment_epoch: String(key.deploymentEpoch),
        source_revision: String(key.sourceRevision),
        ...(key.sourceAudioId ? { source_audio_id: key.sourceAudioId } : {}),
        provider: "elevenlabs",
        ...(providerJobId ? { provider_job_id: providerJobId } : {}),
        ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
      },
    });

    let normalized: NormalizedTranscript;
    try {
      normalized = normalizeElevenLabsTranscript(payload, {
        allowEmpty: await deps.allowsEmptyTranscript(key.workflowRunId),
        providerJobId,
        providerRequestId,
        durationSeconds: await deps.sourceDurationSeconds({ projectId, sourceAudioId: key.sourceAudioId, sourceRevision: key.sourceRevision }),
      });
    } catch (error) {
      if (!(error instanceof TranscriptNormalizationError)) throw error;
      return deps.lifecycle.failProviderAttempt(
        key,
        new WorkflowFailure(error.code, "permanent", error.message, { cause: error }),
        providerIds,
      );
    }

    return deps.lifecycle.completeProviderTranscript(key, {
      provider: normalized.provider,
      providerModel: normalized.providerModel,
      providerJobId: normalized.providerJobId,
      providerRequestId: normalized.providerRequestId,
      languageCode: normalized.languageCode,
      languageConfidence: normalized.languageConfidence,
      text: normalized.text,
      utterances: normalized.utterances,
      speakerCount: normalized.speakerCount,
      durationSeconds: normalized.durationSeconds,
      rawStorageKey,
    });
  };
}
