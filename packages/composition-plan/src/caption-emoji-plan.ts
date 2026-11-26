import { captionGraphemes, isCaptionEmojiPresentation } from "@narriflow/caption-fonts/graphemes";
import {
  captionEmojiDrawnTone,
  captionWordKey,
  resolveCaptionEmojiAnchors,
  sourceRangeToEdited,
  sourceWordToEdited,
  type CaptionEmojiAnchorWord,
  type CaptionEmojiRef,
  type EditedTimeMap,
  type EditorDocument,
} from "@narriflow/validators";
import type { CompositionCaptionEmoji, CompositionCaptionVisualLayer } from "./clip-composition-plan";

// Which Caption Emoji goes on which cue, and when (spec D5, D7). Entries are
// stored by Word Key and resolved here over the transcript, so line rewrites
// that re-time words need no reducer logic.

/** A transcript word's position: the utterance's place in the slice and the word's index, -1 for an untimed utterance. */
export function captionEmojiWordId(utterancePosition: number, wordIndex: number): string {
  return `${utterancePosition}:${wordIndex}`;
}

/**
 * The Caption Emoji of each transcript word that has one, as drawn (its id and the tone it is drawn
 * in, `captionEmojiDrawnTone`; absent for the default yellow), by `captionEmojiWordId`; empty when
 * the preset's `emojis` is off. Every word takes part in resolving, cut or censored, so an entry on
 * a removed word lands on that word and draws nothing instead of moving to a neighbour.
 */
export function captionEmojisByWord(document: EditorDocument): Map<string, CaptionEmojiRef> {
  const entries = document.captionPreset.emojis === true ? document.studioEdits.captionEmojis : undefined;
  if (!entries || Object.keys(entries).length === 0) return new Map();
  const words: CaptionEmojiAnchorWord[] = [];
  const ids: string[] = [];
  document.transcriptSlice.forEach((utterance, position) => {
    const span = { utteranceIndex: utterance.index, utteranceStartSec: utterance.startSec, utteranceEndSec: utterance.endSec };
    if (utterance.words.length === 0) {
      words.push({ key: captionWordKey(utterance.startSec), sourceStartSec: utterance.startSec, ...span });
      ids.push(captionEmojiWordId(position, -1));
      return;
    }
    utterance.words.forEach((word, wordIndex) => {
      words.push({ key: captionWordKey(word.startSec), text: word.word, sourceStartSec: word.startSec, ...span });
      ids.push(captionEmojiWordId(position, wordIndex));
    });
  });
  const byWord = new Map<string, CaptionEmojiRef>();
  for (const [key, index] of resolveCaptionEmojiAnchors(entries, words)) {
    const entry = entries[key]!;
    const tone = captionEmojiDrawnTone(entry, document.captionPreset);
    byWord.set(ids[index]!, tone === 0 ? { id: entry.id } : { id: entry.id, tone });
  }
  return byWord;
}

/** A planned emoji before the cue windows are final: on a word of a cue, or at an edited time (dub captions). */
export type PendingCaptionEmoji =
  | { readonly layerIndex: number; readonly wordIndex: number; readonly ref: CaptionEmojiRef }
  | { readonly atSec: number; readonly ref: CaptionEmojiRef };

/**
 * Dub captions have no Word Keys: each emoji's word is mapped through the edited-time map and the
 * emoji joins whichever dub cue is live then. Censor masks do not apply to dub captions, so they
 * do not hide emojis either; a cut word still draws nothing.
 */
export function dubCaptionEmojis(document: EditorDocument, editedTimeMap: EditedTimeMap): PendingCaptionEmoji[] {
  const byWord = captionEmojisByWord(document);
  if (byWord.size === 0) return [];
  const pending: PendingCaptionEmoji[] = [];
  document.transcriptSlice.forEach((utterance, position) => {
    if (utterance.words.length === 0) {
      const ref = byWord.get(captionEmojiWordId(position, -1));
      const range = ref ? sourceRangeToEdited(editedTimeMap, utterance) : null;
      if (ref && range) pending.push({ atSec: range.startSec, ref });
      return;
    }
    utterance.words.forEach((word, wordIndex) => {
      const ref = byWord.get(captionEmojiWordId(position, wordIndex));
      const range = ref ? sourceWordToEdited(editedTimeMap, word) : null;
      if (ref && range) pending.push({ atSec: range.startSec, ref });
    });
  });
  return pending;
}

function cueShowsTypedEmoji(layer: CompositionCaptionVisualLayer): boolean {
  return layer.words.some((word) => captionGraphemes(word.text).some(isCaptionEmojiPresentation));
}

/**
 * Sets each caption layer's `emojis` once its words and window are final. A word's emoji appears
 * when the word starts; a timed emoji joins the cue whose window holds it. A cue whose text already
 * shows a typed emoji takes none. Returns, by layer index, the indexes of the words whose emoji is
 * drawn (a timed emoji has no word of the cue).
 */
export function attachCaptionEmojis(
  layers: CompositionCaptionVisualLayer[],
  pending: readonly PendingCaptionEmoji[],
): ReadonlyMap<number, ReadonlySet<number>> {
  const emojiWords = new Map<number, Set<number>>();
  if (pending.length === 0) return emojiWords;
  const byLayer = new Map<number, Omit<CompositionCaptionEmoji, "order">[]>();
  for (const emoji of pending) {
    let layerIndex: number;
    let atSec: number;
    if ("layerIndex" in emoji) {
      const word = layers[emoji.layerIndex]?.words[emoji.wordIndex];
      if (!word) continue;
      layerIndex = emoji.layerIndex;
      atSec = word.startSec;
      const indexes = emojiWords.get(layerIndex) ?? new Set<number>();
      emojiWords.set(layerIndex, indexes.add(emoji.wordIndex));
    } else {
      layerIndex = layers.findIndex((layer) => layer.activeRange.startSec <= emoji.atSec && emoji.atSec < layer.activeRange.endSec);
      if (layerIndex < 0) continue;
      atSec = emoji.atSec;
    }
    const list = byLayer.get(layerIndex) ?? [];
    list.push({ id: emoji.ref.id, ...(emoji.ref.tone === undefined ? {} : { tone: emoji.ref.tone }), atSec });
    byLayer.set(layerIndex, list);
  }
  for (const layerIndex of byLayer.keys()) {
    if (cueShowsTypedEmoji(layers[layerIndex]!)) {
      byLayer.delete(layerIndex);
      emojiWords.delete(layerIndex);
    }
  }
  const drawn = [...byLayer]
    .flatMap(([layerIndex, emojis]) => emojis.sort((left, right) => left.atSec - right.atSec).map((emoji, at) => ({ layerIndex, at, emoji })));
  // Time order, ties by cue and then by place in the cue: the order the emoji layer sorts a target's emojis in.
  drawn.sort((left, right) => left.emoji.atSec - right.emoji.atSec || left.layerIndex - right.layerIndex || left.at - right.at);
  const emojisOf = new Map<number, CompositionCaptionEmoji[]>();
  drawn.forEach(({ layerIndex, emoji }, order) => {
    const list = emojisOf.get(layerIndex) ?? [];
    list.push({ ...emoji, order });
    emojisOf.set(layerIndex, list);
  });
  for (const [layerIndex, emojis] of emojisOf) layers[layerIndex] = { ...layers[layerIndex]!, emojis };
  return emojiWords;
}
