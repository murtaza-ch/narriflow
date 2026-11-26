import { CAPTION_EMOJI_AI_BADGES, CAPTION_EMOJI_AI_GLYPHS, emojiRefForGlyph } from "@narriflow/caption-emoji/index";
import {
  acceptEmojiPicks,
  chunkTranscriptForEmojiTagging,
  collectEmojiPicks,
  EMOJI_TAGGING_SCHEMA,
  emojiTaggingSystemPrompt,
  type CaptionEmojiPick,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { requestTaggingReport, TAGGING_REQUEST_DEFAULTS, type TaggingFetch, type TaggingRequestConfig } from "./transcript-tagging-request";
import { OPENAI_TEXT_MODEL } from "./openai-models";

// AI Caption Emoji tagging (spec D8): import (selection preparation), the
// Studio suggest route and Apply to all call this one function. Optional
// enrichment: it never throws, and a failed chunk yields no picks. The Worker
// may import the catalog's index only, never its art.

/** Built once: the same bytes on every request, so prompt caching applies. */
export const EMOJI_TAGGING_SYSTEM_PROMPT = emojiTaggingSystemPrompt({ glyphs: CAPTION_EMOJI_AI_GLYPHS, badges: CAPTION_EMOJI_AI_BADGES });

/**
 * Low reasoning, not the text jobs' none: on the four real clips (ticket 20) it took the share of
 * emojis that depict their word from 74% to 94% at Balanced, for a few more output tokens.
 */
export const EMOJI_TAGGING_MODEL = { model: OPENAI_TEXT_MODEL, reasoningEffort: "low" };

/**
 * Measured 2026-11-26 (gpt-6-luna, no reasoning, 500-word chunks, 16 in
 * flight): about 3 s per chunk (first uncached request up to 6.8 s); 2,128
 * words in 3.1-3.8 s wall. Per 1,000 words about 12,100 input tokens (about
 * 7,800 of them the cacheable vocabulary prefix) and 880 output tokens: about
 * $0.0017 at list price before caching, $0.05 for a 3-hour source.
 */
export const EMOJI_TAGGING_DEFAULTS = {
  /** Requests in flight at once. Import runs it beside filler tagging's 24. */
  concurrency: 16,
  /**
   * Reasoning counts toward it. On 500-word chunks (ticket 27) replies are median 1,704 tokens and
   * up to 3,943 on short-sentence Arabic, which draws up to 129 picks, since every pick says `p`
   * and absent or loose picks are written too (before ticket 27: median 1,078, and 2,000 was
   * already exceeded on 2 of 42 chunks). At about 185 tokens a second, 4,000 stays inside the
   * request's 30 s timeout.
   */
  maxOutputTokens: 4_000,
} as const;

export interface CaptionEmojiTaggingInput {
  utterances: TranscriptUtterance[];
  languageCode: string | null;
  title?: string | null;
  /** Absolute time (on `now`'s clock) by which every request has finished. */
  deadline: number;
  signal?: AbortSignal;
}

export interface CaptionEmojiTaggingConfig {
  apiKey: string;
  concurrency?: number;
  fetch?: TaggingFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CaptionEmojiTaggingOutcome {
  chunks: number;
  tagged: number;
  /** Chunks that failed, or whose report was not the schema's shape (after their one retry, when there was time for it). */
  failed: number;
  /** Chunks sent a second time after a failed or invalid reply that was not a 429. */
  retried: number;
  /** Failed chunks whose last reply was a 429. */
  rateLimited: number;
  /** Chunks not sent: no key, past the deadline or aborted. */
  skipped: number;
  /** Chunks whose text could forge prompt structure (never sent). */
  unsafe: number;
  tokensUsed: number;
  /** By Word Key, sorted by key; skin tone never set. */
  picks: CaptionEmojiPick[];
}

/** Suggests emojis for `utterances` in any language. Every chunk is one request, sent once more if it fails. */
export async function tagCaptionEmojis(input: CaptionEmojiTaggingInput, config: CaptionEmojiTaggingConfig): Promise<CaptionEmojiTaggingOutcome> {
  const now = config.now ?? Date.now;
  const chunks = chunkTranscriptForEmojiTagging(input.utterances, input.languageCode, input.title ?? null);
  const accepted: CaptionEmojiPick[][] = chunks.map(() => []);
  const outcome = { chunks: chunks.length, tagged: 0, failed: 0, retried: 0, rateLimited: 0, skipped: 0, unsafe: 0, tokensUsed: 0 };
  if (!config.apiKey.trim()) return { ...outcome, skipped: chunks.length, picks: [] };
  const request: TaggingRequestConfig = { apiKey: config.apiKey, deadline: input.deadline, maxOutputTokens: EMOJI_TAGGING_DEFAULTS.maxOutputTokens,
    fetch: config.fetch, now: config.now, sleep: config.sleep, signal: input.signal };

  let next = 0;
  const work = async () => {
    for (;;) {
      const index = next++;
      if (index >= chunks.length) return;
      const chunk = chunks[index]!;
      const user = chunk.prompt;
      if (user === null) { outcome.unsafe++; continue; }
      if (input.deadline - now() < TAGGING_REQUEST_DEFAULTS.minStartMs || input.signal?.aborted) { outcome.skipped++; continue; }
      const send = () => requestTaggingReport(request, EMOJI_TAGGING_MODEL,
        { system: EMOJI_TAGGING_SYSTEM_PROMPT, user, schemaName: "caption_emojis", schema: EMOJI_TAGGING_SCHEMA });
      // A reply counts only when its report has the schema's shape.
      const attempt = async () => {
        const result = await send();
        outcome.tokensUsed += result.tokens;
        const picks = result.kind === "ok" ? acceptEmojiPicks(chunk, result.report, emojiRefForGlyph, input.languageCode) : null;
        return { picks, rateLimited: result.kind !== "ok" && result.rateLimited === true };
      };
      let result = await attempt();
      // About one request in 30 to 60 ends `response.failed` or completes as text that is not JSON
      // (measured 2026-11-26, ticket 11): one more try while the deadline allows. Not after a 429,
      // which the request already retried.
      if (result.picks === null && !result.rateLimited && input.deadline - now() >= TAGGING_REQUEST_DEFAULTS.minStartMs && !input.signal?.aborted) {
        outcome.retried++;
        result = await attempt();
      }
      if (result.picks === null) {
        outcome.failed++;
        if (result.rateLimited) outcome.rateLimited++;
        continue;
      }
      accepted[index] = result.picks;
      outcome.tagged++;
    }
  };
  const workers = Math.max(1, Math.min(config.concurrency ?? EMOJI_TAGGING_DEFAULTS.concurrency, chunks.length));
  await Promise.all(Array.from({ length: workers }, work));
  return { ...outcome, picks: collectEmojiPicks(chunks, accepted) };
}
