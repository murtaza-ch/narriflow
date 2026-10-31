import { EMBEDDING_INPUT_MAX_CHARS } from "./openai-embedding-provider";

/** One embeddings request carries at most this many inputs and an estimated
 * token total under the provider's 300,000-token request limit. */
export interface EmbeddingBatchLimits {
  maxInputs: number;
  maxEstimatedTokens: number;
}

const DEFAULT_BATCH_LIMITS: EmbeddingBatchLimits = { maxInputs: 128, maxEstimatedTokens: 200_000 };
/** A conservative three characters per token, over text the provider has
 * already cut to its per-input maximum. */
const estimatedTokens = (text: string) => Math.ceil(Math.min(text.length, EMBEDDING_INPUT_MAX_CHARS) / 3);

/** Splits passages, in order, into requests within `limits`. */
export function planEmbeddingBatches<T extends { text: string }>(items: readonly T[], limits: EmbeddingBatchLimits = DEFAULT_BATCH_LIMITS): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const cost = estimatedTokens(item.text);
    if (current.length > 0 && (current.length >= limits.maxInputs || tokens + cost > limits.maxEstimatedTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

