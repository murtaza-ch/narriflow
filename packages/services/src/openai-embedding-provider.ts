const OPENAI_EMBEDDINGS_ENDPOINT = "https://api.openai.com/v1/embeddings";

/** Passages and queries must use the same model and dimensions. Changing
 * either needs a new migration and a re-index. */
export const LIBRARY_EMBEDDING_MODEL = "text-embedding-3-small";
export const LIBRARY_EMBEDDING_DIMENSIONS = 1536;

/** Inputs are cut here: even at two tokens per character that stays under the
 * 8,192-token limit of one input. */
export const EMBEDDING_INPUT_MAX_CHARS = 4_000;

export type EmbeddingProviderFailureCode =
  | "embedding_not_configured"
  | "embedding_request_failed"
  | "embedding_bad_response";

export class EmbeddingProviderError extends Error {
  readonly status: number | null;

  constructor(readonly code: EmbeddingProviderFailureCode, options: { status?: number; cause?: unknown } = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EmbeddingProviderError";
    this.status = options.status ?? null;
  }
}

export interface EmbeddingResult {
  /** One vector per input, in input order. */
  vectors: number[][];
  /** Tokens the provider billed for this request. */
  tokens: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  /** False when no API key is set; indexing then waits instead of failing. */
  readonly configured: boolean;
  embed(texts: readonly string[]): Promise<EmbeddingResult>;
}

export interface OpenAiEmbeddingProviderOptions {
  apiKey: string | undefined;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export function createOpenAiEmbeddingProvider(options: OpenAiEmbeddingProviderOptions): EmbeddingProvider {
  const model = options.model ?? LIBRARY_EMBEDDING_MODEL;
  const request = options.fetch ?? globalThis.fetch;
  return {
    model,
    configured: Boolean(options.apiKey),
    async embed(texts) {
      if (!options.apiKey) throw new EmbeddingProviderError("embedding_not_configured");
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      let response: Response;
      try {
        response = await request(OPENAI_EMBEDDINGS_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            input: texts.map((text) => text.slice(0, EMBEDDING_INPUT_MAX_CHARS)),
            dimensions: LIBRARY_EMBEDDING_DIMENSIONS,
            encoding_format: "float",
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
      } catch (cause) {
        throw new EmbeddingProviderError("embedding_request_failed", { cause });
      }
      if (!response.ok) throw new EmbeddingProviderError("embedding_request_failed", { status: response.status });
      const payload = (await response.json().catch(() => null)) as {
        data?: Array<{ index?: number; embedding?: unknown }>;
        usage?: { total_tokens?: number };
      } | null;
      const data = payload?.data;
      if (!Array.isArray(data) || data.length !== texts.length) throw new EmbeddingProviderError("embedding_bad_response");
      const vectors = [...data]
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        .map((item) => item.embedding);
      for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== LIBRARY_EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
          throw new EmbeddingProviderError("embedding_bad_response");
        }
      }
      return { vectors: vectors as number[][], tokens: payload?.usage?.total_tokens ?? 0 };
    },
  };
}
