"use client";

import { useRef, useSyncExternalStore } from "react";
import type { CaptionEmojiPalette } from "@narriflow/validators";
import { chipVisualOrder } from "./emoji-chip-order";
import {
  captionEmojiHiddenReason,
  captionEmojiSpanKey,
  lineAddWord,
  lineEmojiTargets,
  type CaptionEmojiHiddenReason,
  type CaptionEmojiSpan,
  type CaptionEmojiTarget,
  type LineAddContext,
} from "./caption-emoji-words";
import type { CaptionEmojiEditor } from "./use-caption-emojis";

// The transcript's line chips at scale. One editor resolves the anchors once per document change
// and publishes here; each row selects only its own lines' view, which keeps its identity while
// unchanged, so an emoji edit re-renders only the rows it touches.

export interface CaptionEmojiLinesState {
  readonly editor: CaptionEmojiEditor;
  /** Read when Add is pressed (the playhead moves without re-rendering rows). */
  readonly addContext: () => LineAddContext;
  /** Moves the playhead to base edited seconds; null where there is no playhead. */
  readonly seek: ((editedSec: number) => void) | null;
  /** Base edited ranges of cues that show a typed emoji (`typedEmojiCueRanges`). */
  readonly typedEmojiCues: readonly (readonly [number, number])[];
}

export interface LineEmojiChipView {
  readonly target: CaptionEmojiTarget;
  /** Why the stored emoji does not draw, or null when it does. */
  readonly hidden: CaptionEmojiHiddenReason | null;
}

export interface CaptionEmojiLineView {
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly palette: CaptionEmojiPalette;
  /** Left to right, as the caption draws the words. */
  readonly chips: readonly LineEmojiChipView[];
  /** Some word of the lines can show an emoji. */
  readonly canAdd: boolean;
}

const NOWHERE: LineAddContext = { playheadSec: Number.NaN, heroKeys: new Set() };

export function captionEmojiLineView(state: CaptionEmojiLinesState, lines: readonly CaptionEmojiSpan[], direction: "ltr" | "rtl"): CaptionEmojiLineView {
  const { editor } = state;
  const targets = editor.enabled ? lineEmojiTargets(editor.model, editor.placement, lines) : [];
  const ordered = targets.length > 1 ? chipVisualOrder(targets.map((target) => target.text), direction).map((at) => targets[at]!) : targets;
  return {
    enabled: editor.enabled,
    readOnly: editor.readOnly,
    palette: editor.palette,
    chips: ordered.map((target) => ({ target, hidden: captionEmojiHiddenReason(editor.model.words[target.word]!, state.typedEmojiCues) })),
    canAdd: !editor.readOnly && lineAddWord(editor.model, editor.placement, lines, NOWHERE) !== null,
  };
}

function sameChip(left: LineEmojiChipView, right: LineEmojiChipView): boolean {
  const [a, b] = [left.target, right.target];
  return a.word === b.word && a.key === b.key && a.text === b.text && a.current?.id === b.current?.id && a.current?.tone === b.current?.tone && left.hidden === right.hidden;
}

export function sameCaptionEmojiLineView(left: CaptionEmojiLineView, right: CaptionEmojiLineView): boolean {
  return (
    left.enabled === right.enabled &&
    left.readOnly === right.readOnly &&
    left.palette === right.palette &&
    left.canAdd === right.canAdd &&
    left.chips.length === right.chips.length &&
    left.chips.every((chip, at) => sameChip(chip, right.chips[at]!))
  );
}

export interface CaptionEmojiLines {
  readonly get: () => CaptionEmojiLinesState | null;
  /** Sets the state rows read; subscribers hear of it on `notify`. */
  readonly set: (state: CaptionEmojiLinesState) => void;
  readonly notify: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createCaptionEmojiLines(): CaptionEmojiLines {
  let state: CaptionEmojiLinesState | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      state = next;
    },
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

interface LineSelection {
  current: { state: CaptionEmojiLinesState; key: string; view: CaptionEmojiLineView } | null;
}

/** A row's view of its lines: the previous object while nothing it shows changed. */
export function selectCaptionEmojiLine(store: CaptionEmojiLines, selection: LineSelection, lines: readonly CaptionEmojiSpan[], direction: "ltr" | "rtl"): CaptionEmojiLineView | null {
  const state = store.get();
  if (!state) return null;
  const key = `${captionEmojiSpanKey(lines)}|${direction}`;
  const cached = selection.current;
  if (cached && cached.state === state && cached.key === key) return cached.view;
  const next = captionEmojiLineView(state, lines, direction);
  const view = cached && sameCaptionEmojiLineView(cached.view, next) ? cached.view : next;
  selection.current = { state, key, view };
  return view;
}

export function useCaptionEmojiLine(store: CaptionEmojiLines, lines: readonly CaptionEmojiSpan[], direction: "ltr" | "rtl"): CaptionEmojiLineView | null {
  const selection = useRef<LineSelection["current"]>(null);
  const select = () => selectCaptionEmojiLine(store, selection, lines, direction);
  return useSyncExternalStore(store.subscribe, select, select);
}
