import { CAPTION_EMOJI_AI_BADGES, CAPTION_EMOJI_AI_GLYPHS, emojiRefForGlyph } from "@narriflow/caption-emoji/index";
import {
  acceptEmojiBlockReport,
  emojiAnswerMostlySilent,
  collectEmojiPicks,
  emojiTaggingBlocks,
  emojiTaggingSystemPrompt,
  type CaptionEmojiPick,
  type EmojiBlockAnswer,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { requestTaggingReport, TAGGING_REQUEST_DEFAULTS, type TaggingFetch, type TaggingRequestConfig } from "./transcript-tagging-request";
import { OPENAI_TEXT_MODEL } from "./openai-models";

// AI Caption Emoji tagging (spec D8): import (selection preparation), the
// Studio suggest route and Apply to all call this one function. Optional
// enrichment: it never throws, and a failed block yields no picks. The Worker
// may import the catalog's index only, never its art.

/**
 * Built once: the same bytes on every request, so prompt caching applies. The provider caches the
 * reply schema ahead of it, so a request whose line count it has not seen lately misses the cache
 * once (about 7,000 uncached tokens, $0.0007; ticket 32).
 */
export const EMOJI_TAGGING_SYSTEM_PROMPT = emojiTaggingSystemPrompt({ glyphs: CAPTION_EMOJI_AI_GLYPHS, badges: CAPTION_EMOJI_AI_BADGES });

/**
 * Low reasoning, not the text jobs' none: on the four real clips (ticket 20) it took the share of
 * emojis that depict their word from 74% to 94% at Balanced, and with one answer per line (ticket 32)
 * none gave failed or unparseable replies in two reviews.
 */
export const EMOJI_TAGGING_MODEL = { model: OPENAI_TEXT_MODEL, reasoningEffort: "low" };

/**
 * Measured 2026-11-27 (ticket 32: gpt-6-luna, low reasoning). A Studio clip (34 real clips, 3 runs)
 * is one request: about 8,100 tokens, of which about 7,000 are the cached prefix, in 4.0 s (at most
 * 10.6 s). A 30,000-word import (8,256 caption lines, 81 requests at 16 in flight) takes 44 to 45 s
 * with no 429: per 1,000 words 24,400 input and 3,200 output tokens, about $0.0040 at list price
 * before caching ($0.12 for a 3-hour source); 73% of its input was cached on a first run.
 */
export const EMOJI_TAGGING_DEFAULTS = {
  /** Requests in flight at once. Import runs it beside filler tagging's 24. */
  concurrency: 16,
  /**
   * Reasoning counts toward it. Replies to 96-line requests averaged about 1,170 tokens and reached
   * 1,937 at most (ticket 32, 81 requests); Studio clips at most 1,298. At about 185 tokens a second,
   * 4,000 stays inside the request's 30 s timeout.
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
  /** Requests the transcript needs: blocks of up to EMOJI_TAGGING_BLOCK_LINES caption lines (the field keeps its name). */
  chunks: number;
  tagged: number;
  /** Blocks that failed, or whose report was not answered (after their one retry, when there was time for it). */
  failed: number;
  /** Blocks sent a second time: after a failed reply that was not a 429, one not the schema's shape, or one answering under half its lines. */
  retried: number;
  /** Failed blocks whose last reply was a 429. */
  rateLimited: number;
  /** Blocks not sent: no key, past the deadline or aborted. */
  skipped: number;
  /** Blocks whose text could forge prompt structure (never sent). */
  unsafe: number;
  tokensUsed: number;
  /** By Word Key, sorted by key; skin tone never set. */
  picks: CaptionEmojiPick[];
}

/** Suggests emojis for `utterances` in any language. Every block is one request with its own schema, sent once more if its reply is not an answer. */
export async function tagCaptionEmojis(input: CaptionEmojiTaggingInput, config: CaptionEmojiTaggingConfig): Promise<CaptionEmojiTaggingOutcome> {
  const now = config.now ?? Date.now;
  const { lines, blocks } = emojiTaggingBlocks(input.utterances, input.languageCode, input.title ?? null);
  const answers: (EmojiBlockAnswer | null)[] = blocks.map(() => null);
  const outcome = { chunks: blocks.length, tagged: 0, failed: 0, retried: 0, rateLimited: 0, skipped: 0, unsafe: 0, tokensUsed: 0 };
  if (!config.apiKey.trim()) return { ...outcome, skipped: blocks.length, picks: [] };
  const request: TaggingRequestConfig = { apiKey: config.apiKey, deadline: input.deadline, maxOutputTokens: EMOJI_TAGGING_DEFAULTS.maxOutputTokens,
    fetch: config.fetch, now: config.now, sleep: config.sleep, signal: input.signal };

  let next = 0;
  const work = async () => {
    for (;;) {
      const index = next++;
      if (index >= blocks.length) return;
      const block = blocks[index]!;
      const user = block.prompt;
      if (user === null) { outcome.unsafe++; continue; }
      if (input.deadline - now() < TAGGING_REQUEST_DEFAULTS.minStartMs || input.signal?.aborted) { outcome.skipped++; continue; }
      const attempt = async () => {
        const result = await requestTaggingReport(request, EMOJI_TAGGING_MODEL, { system: EMOJI_TAGGING_SYSTEM_PROMPT, user, schemaName: "caption_emojis", schema: block.schema });
        outcome.tokensUsed += result.tokens;
        return { answer: result.kind === "ok" ? acceptEmojiBlockReport(block, result.report, emojiRefForGlyph, input.languageCode) : null, rateLimited: result.kind !== "ok" && result.rateLimited === true };
      };
      let result = await attempt();
      // About one request in 30 to 60 ends `response.failed` or completes as text that is not JSON
      // (measured 2026-11-26, ticket 11), and a reply may answer too few lines: one more try while the
      // deadline allows. Not after a 429, which the request already retried.
      const canRetry = () => input.deadline - now() >= TAGGING_REQUEST_DEFAULTS.minStartMs && !input.signal?.aborted;
      if (result.answer === null && !result.rateLimited && canRetry()) {
        outcome.retried++;
        result = await attempt();
      }
      // A reply that silences most of a block is asked once more, and the reply with fewer silent
      // lines stands: an account of a death is silenced both times, an ordinary sad story about one
      // run in fourteen (ticket 32), which left a whole clip without emojis.
      else if (result.answer !== null && emojiAnswerMostlySilent(block, result.answer) && canRetry()) {
        outcome.retried++;
        const again = await attempt();
        if (again.answer !== null && again.answer.silent.length < result.answer.silent.length) result = again;
      }
      if (result.answer === null) {
        outcome.failed++;
        if (result.rateLimited) outcome.rateLimited++;
        continue;
      }
      answers[index] = result.answer;
      outcome.tagged++;
    }
  };
  const workers = Math.max(1, Math.min(config.concurrency ?? EMOJI_TAGGING_DEFAULTS.concurrency, blocks.length));
  await Promise.all(Array.from({ length: workers }, work));
  return { ...outcome, picks: collectEmojiPicks(lines, answers) };
}
