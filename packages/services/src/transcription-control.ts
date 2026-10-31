import type { ExecutionDispatchReference, ProviderAttemptReference } from "@narriflow/validators/execution";
import { toProviderLanguageCode, type SourceLanguageCodeValue } from "@narriflow/validators";
import type { createTranscriptionAdmission } from "./transcription-admission";
import type { createScribeFinalizer } from "./scribe-transcript";
import { ScribeSubmissionUnconfirmed, type createScribeProvider } from "./transcription-provider";
import { workflowFailureFromUnknown } from "./workflow-attempt-contract";
import type { ProviderControlState, ProviderDeadlineResult, WorkflowRunLifecycle } from "./workflow-run-lifecycle";

export type TranscriptionControlResult =
  | { kind: "complete"; disposition: "terminal" | "superseded" }
  | { kind: "wait"; dueAt: Date }
  | { kind: "blocked"; reason: "audio_pending" };

export interface TranscriptionControlPorts {
  admission: Pick<ReturnType<typeof createTranscriptionAdmission>, "admit">;
  workflow: Pick<WorkflowRunLifecycle, "readProviderControl" | "recordProviderAcceptance" | "failProviderAttempt" | "expireProviderDeadline" | "observeProviderPending">;
  /** Resolve keys lazily, after supplied/no-audio plans have completed. */
  provider(): Pick<ReturnType<typeof createScribeProvider>, "submit" | "result">;
  sourceAudioGrant(reference: ProviderAttemptReference, expiresAt: Date): Promise<{ sourceAudioId: string; url: string; expiresAt: Date }>;
  /** Only a verified same-owner optional native probe may reach this port. */
  probeLanguage?(reference: ProviderAttemptReference, signal?: AbortSignal): Promise<{ pinned: SourceLanguageCodeValue | null; reason: string }>;
  finalize: ReturnType<typeof createScribeFinalizer>;
  deliverWakes(ids: readonly string[]): Promise<void>;
}

/** Each call starts with a fresh authority read. No cached step value permits a POST. */
export function createTranscriptionControl(ports: TranscriptionControlPorts) {
  async function confirm(result: { dispatchIds?: readonly string[] }) {
    if (result.dispatchIds?.length) await ports.deliverWakes(result.dispatchIds);
  }
  async function settled(result: ProviderDeadlineResult): Promise<TranscriptionControlResult> {
    await confirm(result);
    return result.kind === "sleep" ? { kind: "wait", dueAt: result.dueAt } :
      { kind: "complete", disposition: result.kind === "stale" ? "superseded" : "terminal" };
  }
  function terminal(state: Exclude<ProviderControlState, { kind: "waiting" }>): TranscriptionControlResult {
    return { kind: "complete", disposition: state.kind === "stale" ? "superseded" : "terminal" };
  }
  async function waitOrRecover(key: ProviderAttemptReference, signal?: AbortSignal): Promise<TranscriptionControlResult> {
    const state = await ports.workflow.readProviderControl(key);
    if (state.kind !== "waiting") { await confirm(state); return terminal(state); }
    const kind = state.providerJobId ? "result" : "submission";
    const deadline = state.providerJobId ? state.resultDeadlineAt : state.submissionDeadlineAt;
    if (!deadline) throw new Error("provider_deadline_missing");
    if (deadline <= state.serverTime) return settled(await ports.workflow.expireProviderDeadline(key, { kind, observedDeadlineAt: deadline }));
    if (!state.providerJobId) return { kind: "wait", dueAt: deadline };
    const check = state.nextCheckAt;
    if (!check) throw new Error("provider_check_missing");
    if (check > state.serverTime) return { kind: "wait", dueAt: new Date(Math.min(check.getTime(), deadline.getTime())) };
    signal?.throwIfAborted();
    let result;
    try { result = await ports.provider().result(state.providerJobId, signal); }
    catch (error) {
      signal?.throwIfAborted();
      return settled(await ports.workflow.failProviderAttempt(key, workflowFailureFromUnknown(error), { transcriptionId: state.providerJobId }));
    }
    if (result.kind === "ready") return settled(await ports.finalize({ key, payload: result.payload,
      providerIds: { requestId: state.providerRequestId, transcriptionId: state.providerJobId } }));
    if (result.kind === "failed") return settled(await ports.workflow.failProviderAttempt(key, result.failure,
      { requestId: state.providerRequestId, transcriptionId: state.providerJobId }));
    return settled(await ports.workflow.observeProviderPending(key, { observedCheckAt: check, intervalMs: 30_000 }));
  }
  return {
    async run(reference: ExecutionDispatchReference, options: { signal?: AbortSignal } = {}): Promise<TranscriptionControlResult> {
      options.signal?.throwIfAborted();
      const admitted = await ports.admission.admit(reference, { owner: crypto.randomUUID() });
      await confirm(admitted);
      if (admitted.kind === "completed") return { kind: "complete", disposition: "terminal" };
      if (admitted.kind === "capacity_wait" || admitted.kind === "retry_wait") return { kind: "wait", dueAt: admitted.dueAt };
      if (admitted.kind === "audio_pending") return { kind: "blocked", reason: "audio_pending" };
      if (admitted.kind === "superseded" || admitted.kind === "terminal") return { kind: "complete", disposition: "superseded" };
      if (admitted.kind === "already_waiting") return waitOrRecover(admitted.intent.reference, options.signal);
      if (admitted.kind !== "begun") throw new Error("transcription_admission_invalid");
      const key = admitted.intent.reference;
      let grant: Awaited<ReturnType<TranscriptionControlPorts["sourceAudioGrant"]>>;
      let languageCode = admitted.languageCode;
      try {
        grant = await ports.sourceAudioGrant(key, admitted.intent.providerAudioGrantExpiresAt);
        if (grant.sourceAudioId !== key.sourceAudioId || grant.expiresAt > admitted.intent.providerAudioGrantExpiresAt) throw new Error("source_audio_grant_invalid");
        if (!languageCode && ports.probeLanguage) {
          try { languageCode = toProviderLanguageCode((await ports.probeLanguage(key, options.signal)).pinned); }
          catch { options.signal?.throwIfAborted(); }
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        return settled(await ports.workflow.failProviderAttempt(key, workflowFailureFromUnknown(error)));
      }
      // Native preparation or key lookup can take time. Re-read the provider
      // lineage and DB clock immediately before the single external POST.
      const fresh = await ports.workflow.readProviderControl(key);
      if (fresh.kind !== "waiting") { await confirm(fresh); return terminal(fresh); }
      if (fresh.providerJobId) return waitOrRecover(key, options.signal);
      if (!fresh.submissionDeadlineAt) throw new Error("provider_deadline_missing");
      if (fresh.submissionDeadlineAt <= fresh.serverTime) return settled(await ports.workflow.expireProviderDeadline(key,
        { kind: "submission", observedDeadlineAt: fresh.submissionDeadlineAt }));
      if (grant.expiresAt <= fresh.serverTime) return settled(await ports.workflow.failProviderAttempt(key, workflowFailureFromUnknown(new Error("source_audio_grant_expired"))));
      let accepted;
      try { accepted = await ports.provider().submit({ reference: key, sourceAudioUrl: grant.url, languageCode, signal: options.signal }); }
      catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof ScribeSubmissionUnconfirmed) return { kind: "wait", dueAt: fresh.submissionDeadlineAt };
        return settled(await ports.workflow.failProviderAttempt(key, workflowFailureFromUnknown(error)));
      }
      const result = await ports.workflow.recordProviderAcceptance(key, { ...accepted, nextPollAt: new Date(fresh.serverTime.getTime() + 30_000) });
      await confirm(result);
      return waitOrRecover(key, options.signal);
    },
  };
}
