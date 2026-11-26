import { captionWordVisualOrder } from "@narriflow/caption-fonts/bidi-order";

// Word chips stand where the caption draws their words. Each chip is its own element, so a
// right-to-left container alone would reverse an embedded left-to-right phrase ("New York" would
// read "York New"); the chips are laid out left to right in the order the caption renderers use.

const RIGHT_TO_LEFT = /[֐-ࣿיִ-﷿ﹰ-﻿]/u;

/** Logical indices of `texts` from the left edge, as the caption renderers lay the line out. */
export function chipVisualOrder(texts: readonly string[], direction: "ltr" | "rtl"): number[] {
  if (direction === "ltr" && !texts.some((text) => RIGHT_TO_LEFT.test(text))) return texts.map((_, at) => at);
  return [...captionWordVisualOrder(texts.map((text, at) => ({ text, space: at > 0 })), direction).wordOrder];
}
