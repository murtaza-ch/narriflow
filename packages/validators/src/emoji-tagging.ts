import { z } from "zod";
import { captionWordIsMinor, captionWordIsNumber, captionWordKey, captionWordKeySchema } from "./caption-emphasis";
import { captionEmojiDensitySchema, captionEmojiRefOnWord, captionEmojiRefSchema, captionWordComparable, DEFAULT_CAPTION_EMOJI_DENSITY, type CaptionEmojiPick, type CaptionEmojiRef } from "./caption-emojis";
import { isFillerWord } from "./filler-words";
import { chunkTranscriptForTagging, type TranscriptTaggingChunk } from "./transcript-tagging";
import type { TranscriptUtterance } from "./transcript";

// AI Caption Emoji tagging (spec D8). Pure contract: chunking, prompt,
// schema, acceptance and Word Keys. The provider call lives in services
// (clip-emoji-tagging.ts); this module never touches the network and never
// imports the emoji catalog, so the caller passes the vocabulary and the
// glyph mapping in.

/** Words per request. Emojis are sparse (about one per 20 words), so a chunk
 *  can be twice the filler tagger's: half the requests, and the vocabulary
 *  prefix is cached anyway. Measured in ticket 05 Evidence. */
export const EMOJI_TAGGING_CHUNK_WORDS = 500;
/** Bound on what a selection capsule freezes: about 0.4 MB, above one pick per
 *  sentence of a three-hour source (about 3,000 sentences). */
export const EMOJI_TAG_MAX_PICKS = 5_000;

/** What the tagger may pick: every single design's glyph, and every phrase badge's two-emoji glyph with its name. */
export interface EmojiTaggingVocabulary {
  readonly glyphs: readonly string[];
  readonly badges: readonly { readonly glyph: string; readonly name: string }[];
}

/** The constant system prompt: rules, then the whole vocabulary. Keyed words
 *  go in the user message, so this prefix is identical on every request and
 *  provider prompt caching applies. */
export function emojiTaggingSystemPrompt(vocabulary: EmojiTaggingVocabulary): string {
  return `You add emojis to the captions of a short video, in any language.
You get the video's title and its transcript as numbered words "id:word", one sentence per line.
First list in "serious" every passage about a serious subject: death, an accident, injury, illness or hospital, grief, violence, abuse, disaster, war, crime and similar, in any language.
A passage runs from the id of its first word ("from") to the id of its last word ("to") and covers every line about that event, including how the speaker felt and wishes or prayers for the people in it.
Serious passages get no emoji at all, not even a sad, sick, caring or praying one.
An emoji illustrates the one word it sits on. Pick only when the picture immediately depicts that word (a thing, an action or a feeling the word names) or the concrete meaning of a short fixed expression containing it. A viewer who hears the word should see at once why this exact word has this emoji.
Use the sentence only to settle the word's sense: 😴 on "asleep" in "the baby is finally asleep", but nothing on "sleep" in "let me sleep on it". Skip a word used only as praise or slang, like "sick" meaning great.
Anchor a thing to its own noun, an action to its own verb and a feeling to the word that names it: 😰 on "nervous" in "I felt so nervous", not on "felt": when a feeling is said with feel, be, get or seem and a describing word, the describing word is the anchor. For a fixed expression, use the word that completes its meaning.
Skip topic associations (a picture of the subject on a word that only belongs to it, like a ball on "weekend" in a talk about football), loose metaphors, generic reaction faces on neutral words, and anything whose tone would distract from the speaker. Never anchor a name or title, a number or a unit of measure, a filler or hesitation sound, or a function word.
At most one emoji per line. Pick every word that passes this test, and skip the rest.
Never mock or judge a person, a group, a religion or a culture.
A badge pairs two emojis for one moment, named in the badge list. When a line says that moment, with both of its parts or in the words of its name, pick the badge instead of a single emoji: ☕⏰ on "coffee" in "time for my morning coffee", 🥹🏆 on "proud" in "I am so proud of you". Never pick a badge for one of its parts alone: ☕ alone on "coffee" in "I love coffee". A badge sits on the word that names its moment.
For each pick write k, the word's id; w, the word exactly as written after that id; p, whether the line says the thing, action or feeling that word names is there: "yes" (it is there, happens or is felt, also in a question, a plan or advice to do it, and when only the wording is negative), "no" (the line says it is absent, missing, lacking, not had, not needed, not happening or to be avoided, wherever the negation sits in the line), "if" (only wished, expected, imagined or in a condition); e, one emoji or one badge copied exactly from the lists below, without skin-tone modifiers; s, its strength: 3 = depicts the word immediately, 2 = depicts its sense in this sentence or a fixed expression, 1 = only related to the word (its topic, a thing near it, a metaphor or another word of the line), not a picture of it.
Returning no picks is normal.
Emojis: ${vocabulary.glyphs.join(" ")}
Badges: ${vocabulary.badges.map((badge) => `${badge.glyph} ${badge.name}`).join("; ")}`;
}

// "serious" comes first so the model writes it before its picks; in a pick the word comes before
// its emoji, so the model names what it illustrates before choosing the picture, and says whether
// the line has that thing at all (`p`) before picturing it. Told to skip a negated word or a loose
// match, the model still tagged it (ticket 21); asked to label it, it does, and code drops `p: "no"`
// and strength 1, "only related" (ticket 27).
export const EMOJI_TAGGING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["serious", "picks"],
  properties: { serious: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["from", "to"],
    properties: { from: { type: "integer" }, to: { type: "integer" } } } },
  picks: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["k", "w", "p", "e", "s"],
    properties: { k: { type: "integer" }, w: { type: "string" }, p: { type: "string", enum: ["yes", "no", "if"] }, e: { type: "string" },
      s: { type: "integer", enum: [1, 2, 3] } } } } },
} as const;

/** Sentence-split chunks of at most EMOJI_TAGGING_CHUNK_WORDS words. The
 *  title (user text) is folded to one bounded line so it cannot forge the
 *  prompt's structure; tokens follow the shared rendering and its unsafe-chunk
 *  rule (transcript-tagging.ts). */
export function chunkTranscriptForEmojiTagging(utterances: TranscriptUtterance[], languageCode: string | null, title: string | null): TranscriptTaggingChunk[] {
  const titleLine = (title ?? "").replace(/[\s\p{Z}\p{Cc}]+/gu, " ").trim().slice(0, 200);
  return chunkTranscriptForTagging(utterances, languageCode ?? "unknown", EMOJI_TAGGING_CHUNK_WORDS)
    .map((chunk) => ({ ...chunk, prompt: chunk.prompt === null ? null : `Title: ${titleLine || "none"}\n${chunk.prompt}` }));
}

// EMOJI_TAGGING_SCHEMA's shape: both lists and every pick field required. A report without
// "serious" cannot be checked against serious passages, and a pick without "p" cannot be checked
// for negation, so neither is an answer.
const reportSchema = z.object({ serious: z.array(z.object({ from: z.number(), to: z.number() }).passthrough()),
  picks: z.array(z.object({ k: z.number(), w: z.string(), p: z.string(), e: z.string(), s: z.number() }).passthrough()) }).passthrough();

/**
 * The picks a model report validly makes in one chunk, or null when the
 * report is not EMOJI_TAGGING_SCHEMA's shape or none of its picks names a word
 * of the chunk (the chunk was not tagged, so the caller retries it).
 *
 * A pick names a word when its id is a token of the chunk and its echoed word
 * `w` is that token's text (`captionWordComparable`); otherwise it is
 * malformed and dropped. A well-formed pick is still dropped when its word is
 * a number, a filler or a minor (function) word, when it lies inside a passage
 * the report marks serious (the prompt rule alone was not reliable in Urdu),
 * when the model says its line does not have the thing (`p` other than "yes"
 * or "if"), when the catalog has no design for its glyph (a single emoji or a
 * badge's pair), or when its strength is not 2 or 3 (1 is "only related"). One pick per sentence: the
 * strongest, the first on a tie. Skin tone is dropped: the AI never chooses
 * one, so its emojis take the preset's Skin tone (`captionEmojiDrawnTone`).
 */
export function acceptEmojiPicks(chunk: TranscriptTaggingChunk, report: unknown, refForGlyph: (glyph: string) => CaptionEmojiRef | null, languageCode: string | null): CaptionEmojiPick[] | null {
  const parsed = reportSchema.safeParse(report);
  if (!parsed.success) return null;
  if (chunk.prompt === null) return [];
  const serious = parsed.data.serious.flatMap((range) =>
    Number.isInteger(range.from) && Number.isInteger(range.to) ? [{ from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) }] : []);
  const byLine = new Map<number, CaptionEmojiPick>();
  let named = 0;
  for (const item of parsed.data.picks) {
    const token = Number.isInteger(item.k) ? chunk.tokens[item.k] : undefined;
    const text = token ? captionWordComparable(token.word.word) : "";
    if (!token || text === "" || captionWordComparable(item.w) !== text) continue;
    named++;
    const raw = token.word.word;
    if (captionWordIsNumber(raw, languageCode) || captionWordIsMinor(raw, languageCode) || isFillerWord(token.word, languageCode)) continue;
    if (!Number.isInteger(item.s) || item.s < 2 || item.s > 3) continue;
    if (serious.some((range) => item.k >= range.from && item.k <= range.to)) continue;
    if (item.p !== "yes" && item.p !== "if") continue;
    const ref = refForGlyph(item.e);
    if (!ref || !captionEmojiRefSchema.safeParse({ id: ref.id }).success) continue;
    const current = byLine.get(token.line);
    if (current && current.strength >= item.s) continue;
    byLine.set(token.line, { key: captionWordKey(token.word.startSec), ref: captionEmojiRefOnWord({ id: ref.id }, raw), strength: item.s });
  }
  if (parsed.data.picks.length > 0 && named === 0) return null;
  return [...byLine.values()].sort((left, right) => Number(left.key) - Number(right.key));
}

/**
 * Picks across all chunks, minus picks on a Word Key two source words share
 * (its word is ambiguous, the filler tagger's key rule), sorted by key. Above
 * EMOJI_TAG_MAX_PICKS the weakest are dropped (an extra emoji is harmless,
 * unlike an extra cut).
 */
export function collectEmojiPicks(chunks: readonly TranscriptTaggingChunk[], acceptedPerChunk: readonly (readonly CaptionEmojiPick[])[]): CaptionEmojiPick[] {
  const seen = new Map<string, number>();
  for (const chunk of chunks) for (const token of chunk.tokens) {
    const key = captionWordKey(token.word.startSec);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const picks = acceptedPerChunk.flat().filter((pick) => seen.get(pick.key) === 1);
  const kept = picks.length <= EMOJI_TAG_MAX_PICKS ? picks
    : picks.slice().sort((left, right) => right.strength - left.strength || Number(left.key) - Number(right.key)).slice(0, EMOJI_TAG_MAX_PICKS);
  return kept.slice().sort((left, right) => Number(left.key) - Number(right.key));
}

/** AI picks a selection capsule freezes (`editor.emojiPicks`), by Word Key. */
export const captionEmojiPickSchema = z.strictObject({
  key: captionWordKeySchema,
  ref: captionEmojiRefSchema,
  strength: z.number().int().min(1).max(3),
});
export const captionEmojiPicksSchema = z.array(captionEmojiPickSchema).max(EMOJI_TAG_MAX_PICKS);

/** Body of `POST /projects/:id/clips/:clipId/emojis/suggest`. */
export const suggestClipEmojisSchema = z.strictObject({ density: captionEmojiDensitySchema.default(DEFAULT_CAPTION_EMOJI_DENSITY) });
export type SuggestClipEmojis = z.input<typeof suggestClipEmojisSchema>;
