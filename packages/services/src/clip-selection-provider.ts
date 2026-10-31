import { CLIP_DETECTION_JSON_SCHEMA, extractResponseText } from "./clip-selection-policy";
import { WorkflowFailure, workflowHttpFailureDisposition } from "./workflow-attempt-contract";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ErrorPayload = { error?: { code?: string | null; type?: string | null } };
const QUOTA_ERRORS = new Set(["credit_balance_exhausted", "insufficient_quota"]);
const OBSERVED_HEADERS = ["x-ratelimit-limit-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"] as const;

export function classifyOpenAiHttpFailure(status: number, payload: ErrorPayload | null): { code: string; disposition: "retryable" | "permanent" } {
  if (status === 429 && (QUOTA_ERRORS.has(payload?.error?.code ?? "") || QUOTA_ERRORS.has(payload?.error?.type ?? ""))) return { code: "openai_quota_exhausted", disposition: "permanent" };
  return { code: "openai_request_failed", disposition: workflowHttpFailureDisposition(status) };
}

export type ClipSelectionProviderResult =
  | { kind: "completed"; content: string; tokensUsed: number; providerRequestId: string | null; rateLimitHeaders: Readonly<Record<string, string>> }
  | { kind: "retry"; dueAt: Date; code: string; providerRequestId: string | null; rateLimitHeaders: Readonly<Record<string, string>> };

/** Known-origin one-shot I/O. Workflows persist a due time instead of sleeping here. */
export function createClipSelectionProvider(config: { apiKey: string; model: string; reasoningEffort: string; maxOutputTokens: number; fetch?: Fetch; now?: () => Date }) {
  if (!config.apiKey.trim()) throw new WorkflowFailure("openai_api_key_missing", "permanent", "OpenAI is not configured");
  if (!config.model.trim() || !config.reasoningEffort.trim() || !Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) throw new Error("clip_selection_configuration_invalid");
  const fetchImpl = config.fetch ?? fetch, clock = config.now ?? (() => new Date());
  return {
    async generate(input: { systemPrompt: string; userPrompt: string; operationDeadlineAt: Date; signal?: AbortSignal }): Promise<ClipSelectionProviderResult> {
      const started = clock();
      if (!Number.isFinite(input.operationDeadlineAt.getTime()) || input.operationDeadlineAt <= started) throw new WorkflowFailure("operation_deadline_exceeded", "permanent", "Selection window deadline expired");
      input.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetchImpl("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: config.model, input: [{ role: "system", content: input.systemPrompt }, { role: "user", content: input.userPrompt }],
            reasoning: { effort: config.reasoningEffort }, text: { format: { type: "json_schema", name: "clip_detection", strict: true, schema: CLIP_DETECTION_JSON_SCHEMA } }, max_output_tokens: config.maxOutputTokens }),
          signal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(Math.min(90_000, input.operationDeadlineAt.getTime() - started.getTime()))]) });
      } catch {
        input.signal?.throwIfAborted();
        return { kind: "retry", dueAt: new Date(Math.min(clock().getTime() + 30_000, input.operationDeadlineAt.getTime())), code: "openai_request_failed", providerRequestId: null, rateLimitHeaders: {} };
      }
      const providerRequestId = response.headers.get("x-request-id")?.slice(0, 160) ?? null;
      const rateLimitHeaders: Record<string, string> = {};
      for (const name of OBSERVED_HEADERS) { const value = response.headers.get(name); if (value !== null) rateLimitHeaders[name] = value.slice(0, 100); }
      const payload = await response.json().catch(() => null) as (ErrorPayload & { status?: string; incomplete_details?: { reason?: string };
        usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } }) | null;
      if (!response.ok || !payload) {
        const failure = classifyOpenAiHttpFailure(response.status, payload);
        if (failure.disposition === "permanent") throw new WorkflowFailure(failure.code, "permanent", "OpenAI rejected clip selection");
        const now = clock().getTime(), header = response.headers.get("retry-after");
        const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
        const specified = Number.isFinite(seconds) ? now + seconds * 1000 : header ? Date.parse(header) : NaN;
        return { kind: "retry", dueAt: new Date(Math.min(Math.max(now, Number.isFinite(specified) ? specified : now + 30_000), input.operationDeadlineAt.getTime())),
          code: failure.code, providerRequestId, rateLimitHeaders };
      }
      if (payload.status === "incomplete") throw new WorkflowFailure("clip_detection_truncated", "retryable", "OpenAI response was incomplete");
      let content: string | null;
      try { content = extractResponseText(payload); } catch { content = null; }
      if (!content) return { kind: "retry", dueAt: new Date(Math.min(clock().getTime() + 30_000, input.operationDeadlineAt.getTime())), code: "openai_request_failed", providerRequestId, rateLimitHeaders };
      const measured = payload.usage?.total_tokens ?? (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0);
      const tokensUsed = Number.isSafeInteger(measured) && measured >= 0 ? measured : 0;
      return { kind: "completed", content, tokensUsed, providerRequestId, rateLimitHeaders };
    },
  };
}
