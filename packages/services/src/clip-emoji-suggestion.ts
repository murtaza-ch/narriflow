import {
  autoCensorWordId,
  buildEditedTimeMap,
  captionWordKey,
  selectCaptionEmojiPicks,
  sourceWordToEdited,
  type CaptionEmojiDensity,
  type CaptionEmojiPickWord,
  type CaptionEmojiRef,
  type EditorDocument,
  type TranscriptUtterance,
} from "@narriflow/validators";
import type { CaptionEmojiTaggingInput, CaptionEmojiTaggingOutcome } from "./clip-emoji-tagging";

// Caption Emojis for one clip's current Editor Document: the Studio suggest
// route and Apply to all use this. Read-only: the caller writes the result.

export type ClipEmojiTagger = (input: CaptionEmojiTaggingInput) => Promise<CaptionEmojiTaggingOutcome>;

export interface ClipEmojiSuggestion {
  /** By Word Key; empty when nothing fits or nothing could be tagged. */
  emojis: Record<string, CaptionEmojiRef>;
  /** Null when the clip has no words to tag, so the model was not called. */
  outcome: CaptionEmojiTaggingOutcome | null;
  /** Every chunk was tagged, so `emojis` covers the whole clip; false keeps a partial set
   *  from standing in for a full one. True when there was nothing to tag. */
  complete: boolean;
}

/** The words of a clip that can carry an emoji, with their edited start: kept by its deleted
 *  ranges and, when `censorSegments` is given, not hidden by a caption mask. `utterances` holds
 *  them by line (the model's input); a line with none left is dropped. */
export function clipEmojiWords(clip: Pick<EditorDocument, "transcriptSlice" | "clipStartSec" | "clipEndSec" | "deletedRanges"> & { censorSegments?: EditorDocument["censorSegments"] }):
  { utterances: TranscriptUtterance[]; words: CaptionEmojiPickWord[] } {
  const masked = new Set((clip.censorSegments ?? [])
    .filter((segment) => segment.enabled && segment.treatment === "caption_mask" && segment.captionMaskPolicy !== null)
    .flatMap((segment) => segment.sourceWordIds));
  const map = buildEditedTimeMap(clip.deletedRanges, { startSec: clip.clipStartSec, endSec: clip.clipEndSec });
  const words: CaptionEmojiPickWord[] = [];
  const utterances = clip.transcriptSlice.flatMap((utterance) => {
    const offered = utterance.words.filter((word, wordIndex) => {
      const range = sourceWordToEdited(map, word);
      if (!range || masked.has(autoCensorWordId({ utteranceIndex: utterance.index, wordIndex, word }))) return false;
      words.push({ key: captionWordKey(word.startSec), editedStartSec: range.startSec });
      return true;
    });
    return offered.length > 0 ? [{ ...utterance, words: offered }] : [];
  });
  return { utterances, words };
}

/** Why a suggestion produced nothing usable: null when tagging ran (or had
 *  nothing to tag) and an empty result means "no emojis fit". */
export function clipEmojiSuggestionFailure(outcome: CaptionEmojiTaggingOutcome | null): "openai_rate_limited" | "clip_emoji_suggestion_failed" | null {
  if (!outcome || outcome.tagged > 0 || outcome.failed + outcome.skipped === 0) return null;
  return outcome.rateLimited > 0 ? "openai_rate_limited" : "clip_emoji_suggestion_failed";
}

/** A suggestion needs the project's finished transcript: without one the clip's words are absent or
 *  about to change, which is `transcript_not_ready`, not "no emojis fit". */
export function clipEmojiTranscriptFailure(transcript: { status: string } | null | undefined): "transcript_not_ready" | null {
  return transcript?.status === "completed" ? null : "transcript_not_ready";
}

/**
 * AI emojis for a clip at `density`, by Word Key. A clip with no words returns
 * an empty map without calling the model. Never throws for a provider failure:
 * `clipEmojiSuggestionFailure(outcome)` tells failure from "nothing fits".
 */
export async function suggestClipEmojis(
  input: { document: EditorDocument; languageCode: string | null; title: string | null; density: CaptionEmojiDensity; deadline: number; signal?: AbortSignal },
  tag: ClipEmojiTagger,
): Promise<ClipEmojiSuggestion> {
  const { utterances, words } = clipEmojiWords(input.document);
  if (words.length === 0) return { emojis: {}, outcome: null, complete: true };
  const outcome = await tag({ utterances, languageCode: input.languageCode, title: input.title, deadline: input.deadline, signal: input.signal });
  return { emojis: selectCaptionEmojiPicks(outcome.picks, words, input.density), outcome, complete: outcome.tagged === outcome.chunks };
}
