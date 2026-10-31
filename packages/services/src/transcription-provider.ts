import { SCRIBE_MODEL_ID } from "@narriflow/validators";
import { scribeErrorDetail, scribeHttpFailure } from "./scribe-errors";
import { WorkflowFailure } from "./workflow-attempt-contract";

/** Every provider callback carries the immutable source lineage submitted to Scribe. */
export type { ProviderAttemptReference as ScribeSubmissionReference } from "@narriflow/validators/execution";
import type { ProviderAttemptReference as ScribeSubmissionReference } from "@narriflow/validators/execution";
export interface ScribeAcceptance { requestId: string; transcriptionId: string }
export type ScribeFetchResult =
  | { kind: "ready"; payload: Record<string, unknown> }
  | { kind: "pending" }
  | { kind: "transient" | "failed"; failure: WorkflowFailure };
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ScribeSubmissionUnconfirmed extends WorkflowFailure {
  constructor() { super("elevenlabs_transcription_submit_failed", "retryable", "Scribe submission acceptance is unknown"); }
}

/** Known-origin provider I/O only. There is no disk, extraction or retry loop here. */
export function createScribeProvider(config: { apiKey: string; webhookId: string; fetch?: Fetch }) {
  if (!config.apiKey.trim()) throw new WorkflowFailure("elevenlabs_api_key_missing", "permanent", "Scribe is not configured");
  if (!config.webhookId.trim()) throw new WorkflowFailure("elevenlabs_webhook_not_configured", "permanent", "Scribe webhook is not configured");
  const fetchImpl = config.fetch ?? fetch;
  const endpoint = "https://api.elevenlabs.io/v1/speech-to-text";
  const headers = { "xi-api-key": config.apiKey };
  return {
    async submit(input: { reference: ScribeSubmissionReference; sourceAudioUrl: string; languageCode: string | null; signal?: AbortSignal }): Promise<ScribeAcceptance> {
      if (!input.reference.sourceAudioId) throw new WorkflowFailure("source_audio_pending", "retryable", "Immutable Source Audio is not ready");
      const source = new URL(input.sourceAudioUrl);
      if (source.protocol !== "https:" || source.username || source.password || source.hash) throw new WorkflowFailure("source_audio_grant_invalid", "permanent", "Source Audio grant is invalid");
      input.signal?.throwIfAborted();
      const body = new FormData();
      body.set("model_id", SCRIBE_MODEL_ID);
      body.set("diarize", "true");
      body.set("timestamps_granularity", "word");
      body.set("tag_audio_events", "false");
      body.set("webhook", "true");
      body.set("webhook_id", config.webhookId);
      body.set("webhook_metadata", JSON.stringify(input.reference));
      body.set("cloud_storage_url", input.sourceAudioUrl);
      if (input.languageCode) body.set("language_code", input.languageCode);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, { method: "POST", headers, body,
          signal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(60_000)]) });
      } catch {
        input.signal?.throwIfAborted();
        throw new ScribeSubmissionUnconfirmed();
      }
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) throw scribeHttpFailure("submit", response.status, payload);
      if (typeof payload?.request_id !== "string" || !payload.request_id || typeof payload.transcription_id !== "string" || !payload.transcription_id) throw new ScribeSubmissionUnconfirmed();
      return { requestId: payload.request_id, transcriptionId: payload.transcription_id };
    },

    async result(transcriptionId: string, signal?: AbortSignal): Promise<ScribeFetchResult> {
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetchImpl(`${endpoint}/transcripts/${encodeURIComponent(transcriptionId)}`, { headers,
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]) });
      } catch {
        signal?.throwIfAborted();
        return { kind: "transient", failure: new WorkflowFailure("elevenlabs_transcript_fetch_failed", "retryable", "Scribe result request failed") };
      }
      const payload = await response.json().catch(() => null);
      if (response.ok) return payload && typeof payload === "object" && !Array.isArray(payload)
        ? { kind: "ready", payload: payload as Record<string, unknown> }
        : { kind: "transient", failure: new WorkflowFailure("elevenlabs_transcript_fetch_failed", "retryable", "Scribe returned an unreadable transcript") };
      if (response.status === 404 && scribeErrorDetail(payload).code === "transcript_not_found") return { kind: "pending" };
      const failure = scribeHttpFailure("result", response.status, payload);
      return { kind: failure.disposition === "permanent" ? "failed" : "transient", failure };
    },
  };
}
