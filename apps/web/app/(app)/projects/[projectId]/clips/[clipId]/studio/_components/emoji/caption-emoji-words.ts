import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { captionGraphemes, isCaptionEmojiPresentation } from "@narriflow/caption-fonts/graphemes";
import {
  autoCensorWordId,
  captionTextDirection,
  captionWordComparable,
  captionWordKey,
  languageDirection,
  resolveCaptionEmojiAnchors,
  sourceRangeToEdited,
  sourceWordToEdited,
  type CaptionEmojiAnchorWord,
  type CaptionEmojiRef,
  type EditedTimeMap,
  type EditorDocument,
} from "@narriflow/validators";
import { chipVisualOrder } from "./emoji-chip-order";

// The words of a clip an emoji can sit on, and where the stored entries land, for the Studio's
// controls. The composition plan decides what draws; this mirrors its rules (anchors resolve over
// every word, cut and censored words draw nothing) so a chip never shows an emoji the video hides.

export interface CaptionEmojiWord {
  /** The word's own Word Key. */
  readonly key: string;
  /** The transcript word; an untimed line is one word holding the line's text. */
  readonly text: string;
  /** Position of its line in the transcript slice. */
  readonly line: number;
  /** Edited seconds; null when the word is cut. */
  readonly editedStartSec: number | null;
  readonly editedEndSec: number | null;
  /** Censored with a caption mask: it takes no emoji. */
  readonly masked: boolean;
}

export interface CaptionEmojiWords {
  readonly words: readonly CaptionEmojiWord[];
  readonly byKey: ReadonlyMap<string, number>;
  /** `[first, end)` word indices of each transcript line. */
  readonly lines: readonly (readonly [number, number])[];
  readonly anchors: readonly CaptionEmojiAnchorWord[];
}

type EmojiWordsInput = Pick<EditorDocument, "transcriptSlice" | "censorSegments">;

function maskedWordIds(document: EmojiWordsInput): ((utteranceIndex: number, wordIndex: number, word: EditorDocument["transcriptSlice"][number]["words"][number]) => boolean) | null {
  const masks = document.censorSegments.filter((segment) => segment.enabled && segment.treatment === "caption_mask" && segment.captionMaskPolicy !== null);
  if (masks.length === 0) return null;
  const ids = new Set(masks.flatMap((segment) => segment.sourceWordIds));
  return (utteranceIndex, wordIndex, word) => ids.has(autoCensorWordId({ utteranceIndex, wordIndex, word }));
}

/** Every word of the slice, in transcript order. */
export function captionEmojiWords(document: EmojiWordsInput, editedTimeMap: EditedTimeMap): CaptionEmojiWords {
  const words: CaptionEmojiWord[] = [];
  const anchors: CaptionEmojiAnchorWord[] = [];
  const lines: (readonly [number, number])[] = [];
  const isMasked = maskedWordIds(document);
  document.transcriptSlice.forEach((utterance, line) => {
    const first = words.length;
    const span = { utteranceIndex: utterance.index, utteranceStartSec: utterance.startSec, utteranceEndSec: utterance.endSec };
    if (utterance.words.length === 0) {
      const range = sourceRangeToEdited(editedTimeMap, utterance);
      const key = captionWordKey(utterance.startSec);
      words.push({ key, text: utterance.text, line, editedStartSec: range?.startSec ?? null, editedEndSec: range?.endSec ?? null, masked: false });
      anchors.push({ key, sourceStartSec: utterance.startSec, ...span });
    } else {
      utterance.words.forEach((word, wordIndex) => {
        const range = sourceWordToEdited(editedTimeMap, word);
        const key = captionWordKey(word.startSec);
        words.push({
          key,
          text: word.word,
          line,
          editedStartSec: range?.startSec ?? null,
          editedEndSec: range?.endSec ?? null,
          masked: isMasked?.(utterance.index, wordIndex, word) ?? false,
        });
        anchors.push({ key, text: word.word, sourceStartSec: word.startSec, ...span });
      });
    }
    lines.push([first, words.length]);
  });
  const byKey = new Map<string, number>();
  words.forEach((word, index) => {
    if (!byKey.has(word.key)) byKey.set(word.key, index);
  });
  return { words, byKey, lines, anchors };
}

/** True when an emoji on this word is drawn: the word is kept and not censored. */
export function captionEmojiWordShows(word: CaptionEmojiWord): boolean {
  return word.editedStartSec !== null && !word.masked;
}

export interface PlacedCaptionEmoji {
  /** The stored entry's key (it may sit a few ms off its word's own key). */
  readonly entryKey: string;
  readonly ref: CaptionEmojiRef;
  readonly word: number;
}

export interface CaptionEmojiPlacement {
  readonly byWord: ReadonlyMap<number, PlacedCaptionEmoji>;
  /** Entries drawn on the video (on a kept, uncensored word). */
  readonly shown: number;
}

type CaptionEmojiEntries = Readonly<Record<string, CaptionEmojiRef>> | undefined;

/** Where each stored entry lands, by the same anchor rule the plan uses. */
export function placeCaptionEmojis(entries: CaptionEmojiEntries, model: CaptionEmojiWords): CaptionEmojiPlacement {
  const byWord = new Map<number, PlacedCaptionEmoji>();
  if (!entries) return { byWord, shown: 0 };
  let shown = 0;
  for (const [entryKey, word] of resolveCaptionEmojiAnchors(entries, model.anchors)) {
    byWord.set(word, { entryKey, ref: entries[entryKey]!, word });
    if (captionEmojiWordShows(model.words[word]!)) shown += 1;
  }
  return { byWord, shown };
}

/** What a gesture on a word changes: its stored entry, or a new entry at the word's own key. */
export interface CaptionEmojiTarget {
  readonly word: number;
  readonly key: string;
  readonly text: string;
  readonly current: CaptionEmojiRef | null;
}

export function captionEmojiTarget(model: CaptionEmojiWords, placement: CaptionEmojiPlacement, word: number): CaptionEmojiTarget {
  const placed = placement.byWord.get(word);
  return { word, key: placed?.entryKey ?? model.words[word]!.key, text: model.words[word]!.text, current: placed?.ref ?? null };
}

export interface CaptionEmojiChip {
  /** The word as the caption shows it. */
  readonly text: string;
  /** Null when the word takes no emoji here (censored, or a dubbed caption with no source word). */
  readonly target: CaptionEmojiTarget | null;
}

export interface LiveCueEmojiChips {
  /** Left to right, as the caption draws the words. */
  readonly chips: readonly CaptionEmojiChip[];
  readonly direction: "ltr" | "rtl";
  /** The cue already shows a typed emoji, so no added emoji draws on it. */
  readonly typedEmoji: boolean;
}

/**
 * A classic cue's words carry no Word Keys: each is matched to the kept word with the same letters
 * that starts at its time, or, for the part of a word a scene inserted inside it leaves after the
 * scene (which starts later than the word), that spans its start.
 */
const CLASSIC_MATCH_TOLERANCE_SEC = 0.08;

function classicCueWords(layer: CompositionCaptionVisualLayer, model: CaptionEmojiWords, toBaseEdited: (sec: number) => number): (number | null)[] {
  const used = new Set<number>();
  return layer.words.map((word) => {
    const atSec = toBaseEdited(word.startSec);
    const text = captionWordComparable(word.text);
    let best: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    model.words.forEach((candidate, index) => {
      if (candidate.editedStartSec === null || used.has(index)) return;
      const distance = Math.abs(candidate.editedStartSec - atSec);
      const spans = candidate.editedEndSec !== null && candidate.editedStartSec < atSec && atSec < candidate.editedEndSec;
      if ((distance <= CLASSIC_MATCH_TOLERANCE_SEC || spans) && distance <= bestDistance && captionWordComparable(candidate.text) === text) {
        best = index;
        bestDistance = distance;
      }
    });
    if (best !== null) used.add(best);
    return best;
  });
}

/**
 * The chips of the cue on screen: one per word, with the word it edits. Scene and Dynamic cues carry
 * Word Keys; a classic cue's words are matched by time and letters. Censored words get no target.
 */
export function liveCueEmojiChips(
  layer: CompositionCaptionVisualLayer,
  model: CaptionEmojiWords,
  placement: CaptionEmojiPlacement,
  toBaseEdited: (sec: number) => number,
): LiveCueEmojiChips {
  const keyed = layer.scene ? { texts: layer.words.map((word) => word.text), keys: layer.scene.keys } : layer.block ? { texts: layer.block.texts, keys: layer.block.keys } : null;
  const texts = keyed ? keyed.texts : layer.words.map((word) => word.text);
  const indices = keyed ? keyed.keys.map((key) => (key === null ? null : (model.byKey.get(key) ?? null))) : classicCueWords(layer, model, toBaseEdited);
  const direction = captionTextDirection(texts.join(" "), layer.language ? languageDirection(layer.language) : undefined);
  const chips = chipVisualOrder(texts, direction).map((at): CaptionEmojiChip => {
    const word = indices[at] ?? null;
    return { text: texts[at]!, target: word === null || model.words[word]!.masked ? null : captionEmojiTarget(model, placement, word) };
  });
  return { chips, direction, typedEmoji: cueShowsTypedEmoji(layer) };
}

/**
 * Words a transcript row addresses: a whole line (its slice position), or a run of one line's words,
 * `[from, to)` indices into its words (a caption row: the words from its first to the next caption's).
 */
export type CaptionEmojiSpan = number | { readonly line: number; readonly from: number; readonly to: number };

export function captionEmojiSpanKey(spans: readonly CaptionEmojiSpan[]): string {
  return spans.map((span) => (typeof span === "number" ? `${span}` : `${span.line}:${span.from}-${span.to}`)).join(",");
}

function lineWords(model: CaptionEmojiWords, spans: readonly CaptionEmojiSpan[]): number[] {
  return spans.flatMap((span) => {
    const line = typeof span === "number" ? span : span.line;
    const range = model.lines[line];
    if (!range) return [];
    const [first, end] = typeof span === "number" ? range : [range[0] + span.from, Math.min(range[1], range[0] + span.to)];
    return Array.from({ length: Math.max(0, end - first) }, (_, at) => first + at);
  });
}

/** The emojis placed on these lines' words, in word order (cut and censored ones included: they can still be removed). */
export function lineEmojiTargets(model: CaptionEmojiWords, placement: CaptionEmojiPlacement, lines: readonly CaptionEmojiSpan[]): CaptionEmojiTarget[] {
  return lineWords(model, lines)
    .filter((word) => placement.byWord.has(word))
    .map((word) => captionEmojiTarget(model, placement, word));
}

export interface LineAddContext {
  /** The playhead in base edited seconds. */
  readonly playheadSec: number;
  /** Word Keys the caption styles drew as the hero of their cue. */
  readonly heroKeys: ReadonlySet<string>;
}

const letterCount = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "").length;

/**
 * The word "Add emoji" on a line anchors to: the word under the playhead when the playhead is inside
 * the line, else the line's hero word, else its longest word (the later one on a tie). Words that
 * already hold an emoji are passed over while another word is free. Null when no word can show one.
 */
export function lineAddWord(model: CaptionEmojiWords, placement: CaptionEmojiPlacement, lines: readonly CaptionEmojiSpan[], context: LineAddContext): number | null {
  const candidates = lineWords(model, lines).filter((word) => captionEmojiWordShows(model.words[word]!));
  if (candidates.length === 0) return null;
  const free = candidates.filter((word) => !placement.byWord.has(word));
  const pool = free.length > 0 ? free : candidates;
  const first = model.words[candidates[0]!]!;
  const last = model.words[candidates.at(-1)!]!;
  if (context.playheadSec >= first.editedStartSec! && context.playheadSec < (last.editedEndSec ?? last.editedStartSec!)) {
    const spoken = [...pool].reverse().find((word) => model.words[word]!.editedStartSec! <= context.playheadSec);
    if (spoken !== undefined) return spoken;
  }
  const hero = pool.find((word) => context.heroKeys.has(model.words[word]!.key));
  if (hero !== undefined) return hero;
  return pool.reduce((best, word) => (letterCount(model.words[word]!.text) >= letterCount(model.words[best]!.text) ? word : best));
}

/** Word Keys drawn as a hero (Scene and Dynamic cues); empty for classic presets. */
export function heroWordKeys(layers: readonly CompositionCaptionVisualLayer[]): Set<string> {
  const keys = new Set<string>();
  for (const layer of layers) {
    const cue = layer.scene ?? layer.block;
    if (!cue) continue;
    cue.roles.forEach((role, at) => {
      const key = cue.keys[at];
      if (role === "hero" && key) keys.add(key);
    });
  }
  return keys;
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/** The plan's rule (`caption-emoji-plan.ts`): a cue whose text shows a typed emoji draws no added one. */
function cueShowsTypedEmoji(layer: CompositionCaptionVisualLayer): boolean {
  return layer.words.some((word) => PICTOGRAPHIC.test(word.text) && captionGraphemes(word.text).some(isCaptionEmojiPresentation));
}

/** Base edited `[start, end)` of the cues that show a typed emoji (most clips: none). */
export function typedEmojiCueRanges(layers: readonly CompositionCaptionVisualLayer[], toBaseEdited: (sec: number) => number): (readonly [number, number])[] {
  return layers.filter(cueShowsTypedEmoji).map((layer) => [toBaseEdited(layer.activeRange.startSec), toBaseEdited(layer.activeRange.endSec)] as const);
}

export type CaptionEmojiHiddenReason = "cut" | "censored" | "typed-emoji";

/** Why an emoji stored on this word does not draw, or null when it does. */
export function captionEmojiHiddenReason(word: CaptionEmojiWord, typedEmojiCues: readonly (readonly [number, number])[]): CaptionEmojiHiddenReason | null {
  if (word.editedStartSec === null) return "cut";
  if (word.masked) return "censored";
  const at = word.editedStartSec;
  return typedEmojiCues.some(([start, end]) => at >= start && at < end) ? "typed-emoji" : null;
}

export interface EmojiMoveChoice {
  readonly word: number;
  readonly text: string;
  /** The word the emoji is on now. */
  readonly current: boolean;
}

/**
 * The words an emoji can move to, left to right on screen: its own word plus the shown words without
 * an emoji, of its line, or of `within` (a caption row's words) when given.
 */
export function emojiMoveChoices(
  model: CaptionEmojiWords,
  placement: CaptionEmojiPlacement,
  word: number,
  direction: "ltr" | "rtl",
  within?: readonly CaptionEmojiSpan[],
): EmojiMoveChoice[] {
  const line = model.words[word]?.line;
  if (line === undefined) return [];
  const indices = lineWords(model, within ?? [line]);
  if (!indices.includes(word)) return [];
  return chipVisualOrder(indices.map((index) => model.words[index]!.text), direction)
    .map((at) => indices[at]!)
    .filter((index) => index === word || (captionEmojiWordShows(model.words[index]!) && !placement.byWord.has(index)))
    .map((index) => ({ word: index, text: model.words[index]!.text, current: index === word }));
}
