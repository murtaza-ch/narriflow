import {
  TranscriptNormalizationError,
  normalizeElevenLabsTranscript,
  type NormalizedTranscript,
} from "./transcript.service";
import {
  WorkflowFailure,
  type CompleteTranscriptInput,
  type ProviderAttemptKey,
  type ProviderAttemptLookup,
  type ProviderIds,
  type ProviderSettlementResult,
} from "./workflow-run-lifecycle";

export interface ScribeFinalizerDependencies {
  lifecycle: {
    lookupProviderAttempt(key: ProviderAttemptKey, ids?: ProviderIds): Promise<ProviderAttemptLookup>;
    completeProviderTranscript(key: ProviderAttemptKey, input: CompleteTranscriptInput): Promise<ProviderSettlementResult>;
    failProviderAttempt(key: ProviderAttemptKey, failure: WorkflowFailure, ids?: ProviderIds): Promise<ProviderSettlementResult>;
  };
  allowsEmptyTranscript(workflowRunId: string): Promise<boolean>;
  /** The source's exact probed duration, or null when unknown. */
  sourceDurationSeconds(projectId: string): Promise<number | null>;
  storeRawJson(input: { key: string; value: unknown; metadata: Record<string, string> }): Promise<void>;
}

export interface FinalizeScribeTranscriptInput {
  key: ProviderAttemptKey;
  /** The Scribe transcript object: the GET body, or the webhook's `data.transcription`. */
  payload: unknown;
  providerIds: ProviderIds;
}

/** Where an attempt's raw Scribe result is kept. */
export function scribeRawStorageKey(projectId: string, key: ProviderAttemptKey): string {
  return `projects/${projectId}/transcripts/${key.workflowRunId}-${key.attemptId}-elevenlabs-scribe_v2.json`;
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
    const rawStorageKey = scribeRawStorageKey(projectId, key);
    const providerJobId = providerIds.transcriptionId ?? providerJobIdOf(payload);
    const providerRequestId = providerIds.requestId ?? null;

    // The raw result is kept even when it turns out unusable: it is the evidence.
    await deps.storeRawJson({
      key: rawStorageKey,
      value: payload,
      metadata: {
        project_id: projectId,
        workflow_run_id: key.workflowRunId,
        attempt_id: key.attemptId,
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
        durationSeconds: await deps.sourceDurationSeconds(projectId),
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
