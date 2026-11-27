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

/** Words per request: twice the filler tagger's, so half the requests, and the
 *  vocabulary prefix is cached anyway. At up to one pick per 8 words a reply
 *  stays under 3,000 tokens (ticket 30). Measured in ticket 05 Evidence. */
export const EMOJI_TAGGING_CHUNK_WORDS = 500;
/** Bound on what a selection capsule freezes: about 0.4 MB, above the accepted
 *  picks of a three-hour source (about 27,000 words at one per 8 to 17 words);
 *  above it the weakest go. */
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
  return `You add emojis to the captions of a short social video, in any language, the way a good short-form editor does: lively, an emoji every few seconds, and every one of them plainly about the words it appears with.
You get the video's title and its transcript as numbered words "id:word", one sentence per line.
First list in "serious" every passage about a serious subject: death, an accident, injury, illness or hospital, grief, violence, abuse, disaster, war, crime and similar, in any language.
A passage runs from the id of its first word ("from") to the id of its last word ("to") and covers every line about that event, including how the speaker felt and wishes or prayers for the people in it.
Serious passages get no emoji at all, not even a sad, sick, caring or praying one.
Then go through the rest phrase by phrase. A phrase is what fits on one caption: about three to six words. For each phrase ask which emoji a good editor would put there, and offer it when there is a clear answer. A long sentence has several phrases and can take several emojis, one per phrase, never two in one phrase. Code keeps the best candidates and spaces them, so offer every good one and rate it honestly.
An emoji sits on one word of its phrase. It fits in one of two ways:
- It pictures that word: a thing, an action or a feeling the word names. 📱 on "phone", 🏃 on "running", 😰 on "nervous", 😮 on "wow".
- It pictures what the phrase says, and sits on the word that completes that meaning: ❌ on "work" in "it doesn't work", 🤷 on "know" in "nobody knew", ✅ on "solved" in "problem solved", 🐢 on "slowly" in "it moves so slowly", 💡 on "idea" in "then I had an idea", 📈 on "growing" in "sales keep growing", ⏳ on "wait" in "you have to wait", 💸 on "expensive".
A viewer who reads the phrase should see at once why this emoji is there.
The emoji must agree with what the phrase says. When the phrase says a thing is absent, not had, not happening or to be avoided, never picture the thing as if it were there: no wheel on "wheel" in "there's no steering wheel", no lock on "secure" in "it's not secure". Picture the absence itself (🚫 or ❌ on that word) or skip it.
Use an emoji only for what it commonly means: 🤞 is hoping, not swearing; 😋 is tasty food, not fun; 🎶 is music, not any sound or voice; 👏 is applause, not a thing snapping shut. A face or a heart needs a word that names that feeling or reaction (wow, love, scared, funny, cried).
When the lists have no picture of the thing itself, skip it; do not substitute a similar or neighbouring object: no wrench on "hinge", no flashlight on "studio lights", no signal bars on "wireless charging". Do not picture an idiom word by word: nothing running on "I went deep into it".
Use the sentence to settle a word's sense: 😴 on "asleep" in "the baby is finally asleep", but nothing on "sleep" in "let me sleep on it"; nothing on "look" or "see" when it only opens a sentence ("look, I think..."). Skip a word used only as praise or slang, like "sick" meaning great.
Anchor a thing to its own noun, an action to its own verb and a feeling to the word that names it: 😰 on "nervous" in "I felt so nervous", not on "felt". An action gets a picture of the action, not of the thing that does it: no car on "move" in "you can move it".
Not a candidate: a topic association (a picture of the video's subject on a phrase that does not say it, like a ball on "weekend" in a talk about football), a loose metaphor, a generic reaction face on a neutral phrase, anything whose tone would distract from the speaker, a name or title, a number or a unit of measure, a filler or hesitation sound, a function word (a, the, of, to, and, it, is, not and the like).
Never mock or judge a person, a group, a religion or a culture. Words about worship (prayer, the call to prayer, scripture, God, a holy place or a religious feeling) get no emoji.
Do not offer the same emoji twice within a few sentences; choose the next best picture or skip.
A badge pairs two emojis for one moment, named in the badge list. When a phrase says that moment, with both of its parts or in the words of its name, pick the badge instead of a single emoji: ☕⏰ on "coffee" in "time for my morning coffee", 🥹🏆 on "proud" in "I am so proud of you". Never pick a badge for one of its parts alone: ☕ alone on "coffee" in "I love coffee". A badge sits on the word that names its moment.
How many: outside serious passages, offer about one candidate for every 8 words. Most sentences of six words or more have at least one. A stretch of 25 words without a candidate should be rare, and only a clip that is serious from start to end gets none.
For each pick write k, the word's id; w, the word exactly as written after that id; p, whether what the emoji shows is true in this phrase (judge the picture, not the grammar of the word): "yes" (it is there, happens or is felt, also in a question, a plan or advice to do it; ❌ on "work" in "it doesn't work" is "yes", because the failure happens), "no" (the phrase says the thing the emoji shows is absent, missing, lacking, not had, not needed, not happening or to be avoided, wherever the negation sits: a wheel on "wheel" in "there's no steering wheel" is "no"), "if" (only wished, expected, imagined or in a condition); e, one emoji or one badge copied exactly from the lists below, without skin-tone modifiers; s, its strength: 3 = pictures the word itself, immediately; 2 = pictures what the phrase says, or the word's sense in this sentence; 1 = only related (the video's topic, a thing near it, a loose metaphor or another word of the line), not a picture of the word or the phrase.
Emojis: ${vocabulary.glyphs.join(" ")}
Badges: ${vocabulary.badges.map((badge) => `${badge.glyph} ${badge.name}`).join("; ")}`;
}

// "serious" comes first so the model writes it before its picks; in a pick the word comes before
// its emoji, so the model names what it illustrates before choosing the picture, and says whether
// what the emoji shows is true in its phrase (`p`) before picturing it. Told to skip a negated word
// or a loose match, the model still tagged it (ticket 21); asked to label it, it does, and code drops
// strength 1, "only related", and `p: "no"` unless the emoji itself pictures "no" (ticket 30).
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
 * Emojis that picture "no" itself. A pick on one is kept when the model marks it `p: "no"`: the
 * model answers `p` by the grammar of the line, so ❌ on "work" in "it doesn't work" and 🤷 on
 * "know" in "didn't know" came back "no" (21 of 21 times in one review), though they picture
 * exactly what is said. Catalog ids, so the rule needs no language.
 */
export const CAPTION_EMOJI_NEGATION_IDS: ReadonlySet<string> = new Set(["cross", "prohibited", "no-entry", "person-gesturing-no", "man-gesturing-no",
  "woman-gesturing-no", "person-shrugging", "thumbs-down", "cross-mark-button", "zipped-lips"]);

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
 * when the model marks it `p: "no"` and its emoji is not one of
 * `CAPTION_EMOJI_NEGATION_IDS` (any `p` other than "yes", "if" or "no" is
 * dropped too), when the catalog has no design for its glyph (a single emoji
 * or a badge's pair), or when its strength is not 2 or 3 (1 is "only
 * related"). A sentence may keep several picks: spacing them is the density's
 * job (`selectCaptionEmojiPicks`). Two picks on one word keep the stronger,
 * the first on a tie. Skin tone is dropped: the AI never chooses one, so its
 * emojis take the preset's Skin tone (`captionEmojiDrawnTone`).
 */
export function acceptEmojiPicks(chunk: TranscriptTaggingChunk, report: unknown, refForGlyph: (glyph: string) => CaptionEmojiRef | null, languageCode: string | null): CaptionEmojiPick[] | null {
  const parsed = reportSchema.safeParse(report);
  if (!parsed.success) return null;
  if (chunk.prompt === null) return [];
  const serious = parsed.data.serious.flatMap((range) =>
    Number.isInteger(range.from) && Number.isInteger(range.to) ? [{ from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) }] : []);
  const byWord = new Map<number, CaptionEmojiPick>();
  let named = 0;
  for (const item of parsed.data.picks) {
    const token = Number.isInteger(item.k) ? chunk.tokens[item.k] : undefined;
    const text = token ? captionWordComparable(token.word.word) : "";
    if (!token || text === "" || captionWordComparable(item.w) !== text) continue;
    named++;
    const raw = token.word.word;
    // The English list too: English function words turn up in every language's speech, and a
    // transcript with no language (or one without a word list) otherwise checks only word length.
    if (captionWordIsNumber(raw, languageCode) || captionWordIsMinor(raw, languageCode) || captionWordIsMinor(raw, "en") || isFillerWord(token.word, languageCode)) continue;
    if (!Number.isInteger(item.s) || item.s < 2 || item.s > 3) continue;
    if (serious.some((range) => item.k >= range.from && item.k <= range.to)) continue;
    if (item.p !== "yes" && item.p !== "if" && item.p !== "no") continue;
    const ref = refForGlyph(item.e);
    if (!ref || !captionEmojiRefSchema.safeParse({ id: ref.id }).success) continue;
    if (item.p === "no" && !CAPTION_EMOJI_NEGATION_IDS.has(ref.id)) continue;
    const current = byWord.get(item.k);
    if (current && current.strength >= item.s) continue;
    byWord.set(item.k, { key: captionWordKey(token.word.startSec), ref: captionEmojiRefOnWord({ id: ref.id }, raw), strength: item.s });
  }
  if (parsed.data.picks.length > 0 && named === 0) return null;
  return [...byWord.values()].sort((left, right) => Number(left.key) - Number(right.key));
}

/**
 * Whether a report lists a serious passage (a range of word ids). A chunk whose report lists none
 * and yields no pick is worth one more request (`tagCaptionEmojis`); a serious one is not, since
 * its emptiness is the answer. Call it on a report `acceptEmojiPicks` accepted.
 */
export function emojiReportListsSerious(report: unknown): boolean {
  const parsed = reportSchema.safeParse(report);
  return parsed.success && parsed.data.serious.some((range) => Number.isInteger(range.from) && Number.isInteger(range.to));
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
