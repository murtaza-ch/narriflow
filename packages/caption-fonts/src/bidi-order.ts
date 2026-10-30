import bidiFactory from "bidi-js";
import { textDirection } from "@narriflow/validators";

/**
 * The Unicode bidi steps a caption line goes through, in one place.
 *
 * Pure: no filesystem, fontkit or HarfBuzz import, so the Studio orders the
 * words of a right-to-left cue with the very functions the worker lays the
 * burn-in out with (`layoutCaptionLine`, shaping.ts). libass resolves the
 * embedding levels (UAX #9) over the whole logical line and places the runs in
 * visual order; a browser that renders each word as its own inline-block would
 * order them by the container's direction alone, so "لیے Extended Family"
 * would read "Family Extended". The Studio renders the words in the order
 * `captionWordVisualOrder` returns, inside a left-to-right container.
 */

const bidi = bidiFactory();

export type CaptionDirection = "ltr" | "rtl";

/** UAX #9 embedding level of every UTF-16 code unit of `text`, for the line's base direction. */
export function resolveBidiLevels(text: string, direction: CaptionDirection): readonly number[] {
  return Array.from(bidi.getEmbeddingLevels(text, direction).levels);
}

/**
 * UAX #9 rule L2: from the highest level down to the lowest odd level, reverse
 * every maximal sequence at that level or above. Returns, for each position of
 * the line as the viewer sees it from the left, the index of the logical item
 * drawn there.
 */
export function reorderByLevels(levels: readonly number[]): number[] {
  const order = levels.map((_, index) => index);
  const maxLevel = Math.max(0, ...levels);
  const minOdd = Math.min(Number.POSITIVE_INFINITY, ...levels.filter((level) => level % 2 === 1));
  for (let level = maxLevel; level >= minOdd; level--) {
    let index = 0;
    while (index < order.length) {
      if (levels[order[index]!]! < level) {
        index++;
        continue;
      }
      let last = index;
      while (last + 1 < order.length && levels[order[last + 1]!]! >= level) last++;
      const reversed = order.slice(index, last + 1).reverse();
      order.splice(index, reversed.length, ...reversed);
      index = last + 1;
    }
  }
  return order;
}

export interface CaptionOrderWord {
  readonly text: string;
  /** A space is drawn before the word (never for the first word). */
  readonly space: boolean;
}

/** One stop of the line from its left edge: a word (logical index) or a space. */
export type CaptionVisualItem = { readonly word: number } | { readonly space: true };

export interface CaptionWordOrder {
  /** The line left to right: every word once, a space wherever the logical line has one between two neighbours. */
  readonly items: readonly CaptionVisualItem[];
  /** Word logical indices left to right. */
  readonly wordOrder: readonly number[];
  /** Each word's own direction (its first strong letter, else the line's), by logical index, for shaping inside the word. */
  readonly wordDirections: readonly CaptionDirection[];
}

/**
 * Where a cue's words stand on screen. `direction` is the line's base
 * direction (the first strong character of the line, or the language's).
 */
export function captionWordVisualOrder(words: readonly CaptionOrderWord[], direction: CaptionDirection): CaptionWordOrder {
  // owner[i] is the word that code unit i belongs to; -1 is a space between words.
  const owners: number[] = [];
  let text = "";
  words.forEach((word, index) => {
    if (index > 0 && word.space) {
      text += " ";
      owners.push(-1);
    }
    text += word.text;
    for (let unit = 0; unit < word.text.length; unit++) owners.push(index);
  });
  const levels = resolveBidiLevels(text, direction);
  const items: CaptionVisualItem[] = [];
  const seen = new Set<number>();
  for (const position of reorderByLevels(levels)) {
    const owner = owners[position]!;
    if (owner === -1) {
      // Never a leading space, never two in a row; a trailing one is dropped below.
      if (items.length > 0 && !("space" in items[items.length - 1]!)) items.push({ space: true });
    } else if (!seen.has(owner)) {
      seen.add(owner);
      items.push({ word: owner });
    }
  }
  while (items.length > 0 && "space" in items[items.length - 1]!) items.pop();
  return {
    items,
    wordOrder: items.flatMap((item) => ("word" in item ? [item.word] : [])),
    wordDirections: words.map((word) => textDirection(word.text, direction)),
  };
}
