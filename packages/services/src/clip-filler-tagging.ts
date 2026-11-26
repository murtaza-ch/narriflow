import {
  acceptFillerTags,
  chunkTranscriptForFillerTagging,
  collectFillerKeys,
  FILLER_TAG_MAX_KEY_LENGTH,
  FILLER_TAG_MAX_KEYS,
  FILLER_TAGGING_PROMPT,
  FILLER_TAGGING_SCHEMA,
  type FillerTaggingOutcome,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { requestTaggingReport, TAGGING_REQUEST_DEFAULTS, type TaggingFetch, type TaggingModel, type TaggingRequest, type TaggingRequestResult } from "./transcript-tagging-request";

// AI filler tagging for one transcript, run once while clip selection
// prepares its frozen input. Optional enrichment: it never throws, and every
// failure leaves its chunk untagged (a missed filler, never a wrong cut).

export interface FillerTaggingConfig {
  apiKey: string;
  /** Every model must accept a token for it to count. */
  models: readonly TaggingModel[];
  /** Absolute time (on `now`'s clock) by which every request has finished. */
  deadline: number;
  /** Requests in flight at once, across all models. */
  concurrency: number;
  maxOutputTokens: number;
  fetch?: TaggingFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Measured 2026-11-13 per ~250-word chunk, gpt-6-luna (none), 1,834
 * requests: p50 2.5 s, p90 3.3 s, p99 6.0 s, max 11.5 s. A very long source
 * may still not be fully tagged within the budget; untagged chunks keep
 * their fillers. Request limits are TAGGING_REQUEST_DEFAULTS.
 */
export const FILLER_TAGGING_DEFAULTS = {
  /** Tagging ends this long after preparation starts; the 2-minute workflow
   *  command keeps 75 s for persistence, delivery and scheduling (Sol v3). */
  budgetMs: 45_000,
  concurrency: 24,
  maxOutputTokens: 4_000,
} as const;

/**
 * Production model (owner decision 2026-11-13). Measured 2026-11-13 with this
 * prompt and the acceptance and key guards, two independent runs: FLEURS
 * (102 languages, 86,659 read-speech tokens) 0 wrong tags in both; Nyra
 * verbatim benchmark (10 languages) 87.7% and 86.7% recall of written
 * fillers, every extra unlabelled tag reviewed as a hesitation; real dev
 * clips 0 Hindi/Urdu tags. About $0.92 per million transcript words.
 * The previous pair (gpt-5.6-luna low AND gpt-5.4 none) also made 0 wrong
 * tags but found 81.6% at $28. Several entries still mean "all must agree".
 */
export const FILLER_TAGGING_MODELS: readonly TaggingModel[] = [
  { model: "gpt-6-luna", reasoningEffort: "none" },
];

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fillerTaggingContract(config: Pick<FillerTaggingConfig, "models" | "maxOutputTokens">): Promise<FillerTaggingOutcome["contract"]> {
  return { models: config.models.map(({ model, reasoningEffort }) => ({ model, reasoningEffort })), promptSha256: await sha256(FILLER_TAGGING_PROMPT),
    schemaSha256: await sha256(JSON.stringify(FILLER_TAGGING_SCHEMA)), maxOutputTokens: config.maxOutputTokens };
}

const fillerRequest = (user: string): TaggingRequest => ({ system: FILLER_TAGGING_PROMPT, user, schemaName: "fillers", schema: FILLER_TAGGING_SCHEMA });

/** Tags hesitation sounds in `utterances` (a non-English transcript). */
export async function tagTranscriptFillers(utterances: TranscriptUtterance[], languageCode: string, config: FillerTaggingConfig): Promise<FillerTaggingOutcome> {
  const now = config.now ?? Date.now;
  const contract = await fillerTaggingContract(config);
  const chunks = chunkTranscriptForFillerTagging(utterances, languageCode);
  const accepted: number[][] = chunks.map(() => []);
  const outcome = { chunks: chunks.length, tagged: 0, failed: 0, skipped: 0, unsafe: 0, tokensUsed: 0 };
  if (!config.apiKey.trim() || config.models.length === 0) return { contract, ...outcome, skipped: chunks.length, overflow: false, keys: [] };

  let next = 0;
  const work = async () => {
    for (;;) {
      const index = next++;
      if (index >= chunks.length) return;
      const chunk = chunks[index]!;
      if (chunk.prompt === null) { outcome.unsafe++; continue; }
      if (config.deadline - now() < TAGGING_REQUEST_DEFAULTS.minStartMs) { outcome.skipped++; continue; }
      // Below one request per model, models run one after another to honour the cap.
      const results = config.concurrency >= config.models.length
        ? await Promise.all(config.models.map((model) => requestTaggingReport(config, model, fillerRequest(chunk.prompt!))))
        : await config.models.reduce(async (done, model) => [...await done, await requestTaggingReport(config, model, fillerRequest(chunk.prompt!))], Promise.resolve([] as TaggingRequestResult[]));
      outcome.tokensUsed += results.reduce((sum, r) => sum + r.tokens, 0);
      if (results.some((r) => r.kind !== "ok")) { outcome.failed++; continue; }
      // Agreement: a token counts only when every model accepts it.
      const sets = results.map((r) => new Set(acceptFillerTags(chunk, (r as { report: unknown }).report)));
      accepted[index] = [...sets[0]!].filter((id) => sets.every((set) => set.has(id))).sort((a, b) => a - b);
      outcome.tagged++;
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(config.concurrency / config.models.length), chunks.length));
  await Promise.all(Array.from({ length: workers }, work));
  const keys = collectFillerKeys(chunks, accepted).filter((key) => key.length <= FILLER_TAG_MAX_KEY_LENGTH);
  // Too many tags to freeze is itself suspicious: keep none rather than an arbitrary subset.
  const overflow = keys.length > FILLER_TAG_MAX_KEYS;
  return { contract, ...outcome, overflow, keys: overflow ? [] : keys };
}
