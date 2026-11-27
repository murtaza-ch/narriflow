import { CAPTION_EMOJI_AI_BADGES, CAPTION_EMOJI_AI_GLYPHS, emojiRefForGlyph } from "@narriflow/caption-emoji/index";
import {
  acceptEmojiPicks,
  chunkTranscriptForEmojiTagging,
  collectEmojiPicks,
  EMOJI_TAGGING_SCHEMA,
  emojiReportListsSerious,
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
 * Measured 2026-11-27 (ticket 30: gpt-6-luna, low reasoning, 16 in flight). A Studio clip
 * (34 real clips, 3 runs) is one request: about 8,800 tokens, of which about 7,800 are the cached
 * prefix, in 4.1 s (at most 7.0 s). The written fixtures joined per language (733 to 1,317 words,
 * 500-word chunks): per 1,000 words 2.4 requests, 23,700 input and 3,700 output tokens, about
 * $0.0042 at list price before caching ($0.11 for a 3-hour source); 9 to 16 s wall.
 */
export const EMOJI_TAGGING_DEFAULTS = {
  /** Requests in flight at once. Import runs it beside filler tagging's 24. */
  concurrency: 16,
  /**
   * Reasoning counts toward it. On 500-word chunks replies averaged about 1,550 tokens and reached
   * 2,823 at most (ticket 30, 30 chunks in four languages; ticket 27's longer prompt reached 3,943
   * on short-sentence Arabic, and 2,000 was exceeded before it). At about 185 tokens a second,
   * 4,000 stays inside the request's 30 s timeout.
   */
  maxOutputTokens: 4_000,
} as const;

/**
 * A chunk of at least this many words whose report lists no serious passage and keeps no pick is
 * sent once more (ticket 30). A shorter chunk can honestly have nothing to picture.
 */
export const EMOJI_TAGGING_EMPTY_RETRY_WORDS = 30;

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
  /** Chunks sent a second time: after a failed or invalid reply that was not a 429, or an empty one (EMOJI_TAGGING_EMPTY_RETRY_WORDS). */
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

/** Suggests emojis for `utterances` in any language. Every chunk is one request, sent once more if it fails or comes back empty. */
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
        const serious = result.kind === "ok" && emojiReportListsSerious(result.report);
        return { picks, serious, rateLimited: result.kind !== "ok" && result.rateLimited === true };
      };
      const canRetry = () => input.deadline - now() >= TAGGING_REQUEST_DEFAULTS.minStartMs && !input.signal?.aborted;
      let result = await attempt();
      // About one request in 30 to 60 ends `response.failed` or completes as text that is not JSON
      // (measured 2026-11-26, ticket 11): one more try while the deadline allows. Not after a 429,
      // which the request already retried.
      if (result.picks === null && !result.rateLimited && canRetry()) {
        outcome.retried++;
        result = await attempt();
      } else if (result.picks !== null && result.picks.length === 0 && !result.serious && chunk.tokens.length >= EMOJI_TAGGING_EMPTY_RETRY_WORDS && canRetry()) {
        // An ordinary chunk with no pick is the model's variance (about 1 run in 200, ticket 30), not
        // an answer: the same one more try. A failed second reply keeps the first, empty answer.
        outcome.retried++;
        const again = await attempt();
        if (again.picks !== null) result = again;
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
