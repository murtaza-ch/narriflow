import {
  scribeCallbackFailure,
  type FinalizeScribeTranscriptInput,
  type ProviderAttemptKey,
  type ProviderIds,
  type ProviderSettlementResult,
} from "@narriflow/services";
import { bodyClass } from "../../body-limits";
import { createRouteApp } from "../../http/admission";
import { projectsAdmission } from "./admission";
import { verifyElevenLabsSignature } from "./elevenlabs-signature";

export interface ProjectsWebhookDeps {
  /** The workspace webhook secret, read per request; null while unconfigured. */
  webhookSecret(): string | null;
  now?(): number;
  /** Settles the waiting transcript attempt from a Scribe result (shared with the worker's GET recovery). */
  finalizeScribeTranscript(input: FinalizeScribeTranscriptInput): Promise<ProviderSettlementResult>;
  /** Fails the waiting attempt with the normal retry policy. */
  failProviderAttempt(
    key: ProviderAttemptKey,
    failure: { code: string; retryable: boolean; message: string },
    ids: ProviderIds,
  ): Promise<ProviderSettlementResult>;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** `webhook_metadata` arrives as an object, or as the JSON string the submission carried. */
function attemptKeyOf(metadata: unknown): ProviderAttemptKey | null {
  let value = metadata;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const record = asRecord(value);
  const workflowRunId = nonEmptyString(record?.workflowRunId);
  const attemptId = nonEmptyString(record?.attemptId);
  return workflowRunId && attemptId ? { workflowRunId, attemptId } : null;
}

function log(level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level, message, ...context }));
}

const decoder = new TextDecoder();

/**
 * ElevenLabs speech-to-text delivery (`POST /api/webhooks/elevenlabs`):
 * signature-authenticated, outside the first-party chain, with its own
 * `providerResult` body class (word-level results are far over the 1 MiB
 * webhook class). The signed bytes are read once and hashed as received.
 *
 * Every settlement (applied, duplicate, stale, terminal) and every delivery we
 * cannot act on (unknown type, missing metadata) is a 200 so ElevenLabs stops
 * retrying; only a temporary failure to persist is a 5xx, which it retries.
 */
export function createProjectsWebhookRoutes(deps: ProjectsWebhookDeps) {
  const now = deps.now ?? Date.now;
  return createRouteApp(projectsAdmission).post("/webhooks/elevenlabs", bodyClass("providerResult"), async (c) => {
    const secret = deps.webhookSecret();
    if (!secret) {
      log("error", "elevenlabs_webhook_not_configured");
      return c.json({ error: "elevenlabs_not_configured" }, 503);
    }

    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    const verified = verifyElevenLabsSignature({
      header: c.req.header("elevenlabs-signature"),
      rawBody,
      secret,
      nowMs: now(),
    });
    if (!verified.ok) {
      log("warn", "elevenlabs_webhook_signature_rejected", { reason: verified.reason });
      return c.json({ error: "invalid_signature" }, 401);
    }

    let envelope: Json | null;
    try {
      envelope = asRecord(JSON.parse(decoder.decode(rawBody)));
    } catch {
      envelope = null;
    }
    const ignored = (reason: string, context: Record<string, unknown> = {}) => {
      log("warn", "elevenlabs_webhook_ignored", { reason, ...context });
      return c.json({ received: true, disposition: "ignored" }, 200);
    };
    if (!envelope) return ignored("invalid_json");

    const type = envelope.type;
    try {
      if (type === "speech_to_text_transcription") {
        const data = asRecord(envelope.data);
        const key = attemptKeyOf(data?.webhook_metadata);
        const transcription = asRecord(data?.transcription);
        if (!data || !key) return ignored("missing_or_invalid_metadata", { type });
        if (!transcription) return ignored("missing_transcription", { type, ...key });
        const result = await deps.finalizeScribeTranscript({
          key,
          payload: transcription,
          providerIds: {
            requestId: nonEmptyString(data.request_id),
            transcriptionId: nonEmptyString(transcription.transcription_id),
          },
        });
        return c.json({ received: true, disposition: result.kind }, 200);
      }

      if (type === "webhook_error") {
        const key = attemptKeyOf(envelope.webhook_metadata);
        if (!key) return ignored("missing_or_invalid_metadata", { type });
        // The provider's message picks the code and is logged truncated; it is
        // never stored or shown (the classified failure carries fixed text).
        const failure = scribeCallbackFailure(envelope.error_message);
        log("warn", "elevenlabs_webhook_error_received", {
          ...key,
          code: failure.code,
          providerMessage: typeof envelope.error_message === "string" ? envelope.error_message.slice(0, 200) : null,
        });
        const result = await deps.failProviderAttempt(
          key,
          {
            code: failure.code,
            retryable: failure.disposition === "retryable",
            message: failure.message,
          },
          { requestId: nonEmptyString(envelope.request_id) },
        );
        return c.json({ received: true, disposition: result.kind }, 200);
      }
    } catch (error) {
      log("error", "elevenlabs_webhook_settlement_failed", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return c.json({ error: "elevenlabs_webhook_failed" }, 500);
    }
    return ignored("unknown_type", { type: typeof type === "string" ? type.slice(0, 64) : typeof type });
  });
}

export type ProjectsWebhookRoutes = ReturnType<typeof createProjectsWebhookRoutes>;
