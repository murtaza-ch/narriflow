"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { SmilePlus, X } from "lucide-react";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import type { CaptionEmojiPalette, CaptionEmojiRef } from "@narriflow/validators";
import { captionLayerAt } from "../caption-cue-at";
import type { CaptionTimeSource } from "../caption-block-painter";
import { chipProps } from "../tool-panels/panel-ui";
import { useCaptionEmojiLine, type CaptionEmojiLines, type LineEmojiChipView } from "./caption-emoji-lines";
import { EmojiGlyph } from "./emoji-glyph";
import { openEmojiPicker, useEmojiPickerOpenFor } from "./emoji-picker-host";
import {
  captionEmojiTarget,
  emojiMoveChoices,
  lineAddWord,
  liveCueEmojiChips,
  type CaptionEmojiHiddenReason,
  type CaptionEmojiSpan,
  type CaptionEmojiTarget,
} from "./caption-emoji-words";
import type { CaptionEmojiEditor } from "./use-caption-emojis";
import { captionEmojiName, useCaptionEmojiIndex } from "./use-caption-emoji-index";

/**
 * Opens the picker for one word; picking places or replaces its emoji, Remove clears it, `move` offers
 * its line's words, or the words of `within` (a caption row) when given.
 */
export function openPickerFor(anchor: HTMLElement, editor: CaptionEmojiEditor, target: CaptionEmojiTarget, direction?: "ltr" | "rtl", within?: readonly CaptionEmojiSpan[]) {
  const choices = direction && target.current ? emojiMoveChoices(editor.model, editor.placement, target.word, direction, within) : [];
  openEmojiPicker({
    anchor,
    label: `Emoji on “${target.text}”`,
    current: target.current,
    palette: editor.palette,
    onPick: (ref: CaptionEmojiRef) => {
      if (!editor.enabled) editor.setEnabled(true);
      editor.place(target, ref);
    },
    onRemove: target.current ? () => editor.place(target, null) : null,
    ...(choices.length > 1 ? { move: { words: choices, onMove: (word: number) => editor.move(target, word) } } : {}),
  });
}

/** A line chip: the playhead goes to the emoji's word (where the creator sees it) and the picker opens with its line's words. */
export function openLineEmojiChip(anchor: HTMLElement, lines: CaptionEmojiLines, target: CaptionEmojiTarget, direction: "ltr" | "rtl", within?: readonly CaptionEmojiSpan[]): void {
  const state = lines.get();
  if (!state || state.editor.readOnly) return;
  const at = state.editor.model.words[target.word]?.editedStartSec ?? null;
  if (at !== null) state.seek?.(at);
  openPickerFor(anchor, state.editor, target, direction, within);
}

/** "Add emoji" on a row: the picker opens for the word `lineAddWord` chooses among the row's words. */
export function openLineAddPicker(anchor: HTMLElement, lines: CaptionEmojiLines, spans: readonly CaptionEmojiSpan[]): void {
  const state = lines.get();
  if (!state || state.editor.readOnly) return;
  const { editor } = state;
  const word = lineAddWord(editor.model, editor.placement, spans, state.addContext());
  if (word !== null) openPickerFor(anchor, editor, captionEmojiTarget(editor.model, editor.placement, word));
}

export const HIDDEN_REASONS: Record<CaptionEmojiHiddenReason, string> = {
  cut: "Not shown: this word is cut",
  censored: "Not shown: this word is censored",
  "typed-emoji": "Not shown: this caption already has an emoji",
};

function useChipLabel(target: CaptionEmojiTarget) {
  const index = useCaptionEmojiIndex();
  return target.current ? `${captionEmojiName(index, target.current.id).toLowerCase()} emoji on “${target.text}”, change` : `Add emoji to “${target.text}”`;
}

// ─── On screen now ─────────────────────────────────────────────────────────

/** The caption layer under the playhead; state changes only when the cue does. */
function useLiveCaptionLayer(clock: CaptionTimeSource, layers: readonly CompositionCaptionVisualLayer[]) {
  const [layer, setLayer] = useState(() => captionLayerAt(layers, clock.getSnapshot()));
  useEffect(() => {
    const update = () => setLayer(captionLayerAt(layers, clock.getSnapshot()));
    update();
    return clock.subscribe(update);
  }, [clock, layers]);
  return layer;
}

export interface LiveCueSource {
  readonly clock: CaptionTimeSource;
  readonly layers: readonly CompositionCaptionVisualLayer[];
  /** Composite (preview) seconds to base edited seconds: inserted scenes shift captions. */
  readonly toBaseEdited: (sec: number) => number;
}

function LiveWordChip({ editor, text, target, typedEmoji }: { editor: CaptionEmojiEditor; text: string; target: CaptionEmojiTarget | null; typedEmoji: boolean }) {
  const label = useChipLabel(target ?? { word: -1, key: "", text, current: null });
  const editable = target !== null && !editor.readOnly;
  const [element, setElement] = useState<HTMLElement | null>(null);
  const expanded = useEmojiPickerOpenFor(element);
  const hidden = target?.current && typedEmoji ? HIDDEN_REASONS["typed-emoji"] : null;
  return (
    <Flex
      ref={setElement}
      as={editable ? "button" : "span"}
      aria-label={editable ? (hidden ? `${label}. ${hidden}` : label) : undefined}
      aria-haspopup={editable ? "dialog" : undefined}
      aria-expanded={editable ? expanded : undefined}
      title={target === null ? "This word takes no emoji" : (hidden ?? undefined)}
      align="center"
      gap="6px"
      minW="0"
      maxW="100%"
      cursor={editable ? "pointer" : "default"}
      {...chipProps(expanded)}
      px={target?.current ? "8px" : "12px"}
      opacity={target === null || hidden ? 0.5 : 1}
      _hover={editable ? chipProps(expanded)._hover : undefined}
      onClick={editable ? (event: React.MouseEvent<HTMLElement>) => openPickerFor(event.currentTarget, editor, target) : undefined}
    >
      {target?.current ? <EmojiGlyph id={target.current.id} tone={target.current.tone} palette={editor.palette} size={20} /> : null}
      <Text as="span" truncate>
        {text}
      </Text>
    </Flex>
  );
}

/** "On screen now": the live cue's words, left to right as drawn; tapping one adds, replaces or removes its emoji. */
export function LiveCueEmojiChips({ editor, live }: { editor: CaptionEmojiEditor; live: LiveCueSource }) {
  const layer = useLiveCaptionLayer(live.clock, live.layers);
  const row = useMemo(() => (layer ? liveCueEmojiChips(layer, editor.model, editor.placement, live.toBaseEdited) : null), [layer, editor.model, editor.placement, live.toBaseEdited]);
  if (!row) {
    return (
      <Text fontSize="12px" color="studio.fgMuted">
        Move the playhead to a caption to choose a word.
      </Text>
    );
  }
  const noTargets = row.chips.every((chip) => chip.target === null);
  return (
    <Box>
      <Flex gap="6px" wrap="wrap" dir="ltr" justify={row.direction === "rtl" ? "flex-end" : "flex-start"} role="group" aria-label="Words on screen now">
        {row.chips.map((chip, at) => (
          <LiveWordChip key={at} editor={editor} text={chip.text} target={chip.target} typedEmoji={row.typedEmoji} />
        ))}
      </Flex>
      {noTargets ? (
        <Text mt="2" fontSize="12px" color="studio.fgMuted">
          This caption has no words from the transcript. Add emojis to the original lines in the transcript.
        </Text>
      ) : null}
    </Box>
  );
}

// ─── Transcript lines ──────────────────────────────────────────────────────

export const LineChip = memo(function LineChip({
  chip,
  palette,
  readOnly,
  lines,
  direction,
}: {
  chip: LineEmojiChipView;
  palette: CaptionEmojiPalette;
  readOnly: boolean;
  lines: CaptionEmojiLines;
  direction: "ltr" | "rtl";
}) {
  const { target, hidden } = chip;
  const index = useCaptionEmojiIndex();
  const name = target.current ? captionEmojiName(index, target.current.id).toLowerCase() : "";
  const [element, setElement] = useState<HTMLElement | null>(null);
  const expanded = useEmojiPickerOpenFor(element);
  const reason = hidden ? HIDDEN_REASONS[hidden] : null;
  return (
    <Flex
      align="center"
      minW="0"
      maxW="100%"
      h="26px"
      borderRadius="8px"
      bg={expanded ? "studio.accentSubtle" : "studio.subtle"}
      color={expanded ? "studio.accentFg" : "studio.fgMuted"}
      opacity={hidden ? 0.5 : 1}
      title={reason ?? undefined}
      css={{ "& [data-chip-remove]": { display: "none" }, "&:hover [data-chip-remove], &:focus-within [data-chip-remove]": { display: "flex" } }}
    >
      <Flex
        ref={setElement}
        as="button"
        aria-label={`${name} emoji on “${target.text}”, change${reason ? `. ${reason}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        align="center"
        gap="5px"
        minW="0"
        h="full"
        ps="5px"
        pe="8px"
        borderRadius="8px"
        cursor={readOnly ? "default" : "pointer"}
        fontSize="12px"
        fontWeight="500"
        _hover={readOnly ? undefined : { color: "studio.fg" }}
        onClick={readOnly ? undefined : (event: React.MouseEvent<HTMLElement>) => openLineEmojiChip(event.currentTarget, lines, target, direction)}
      >
        <EmojiGlyph id={target.current!.id} tone={target.current!.tone} palette={palette} size={18} />
        <Text as="span" truncate maxW="96px">
          {target.text}
        </Text>
      </Flex>
      {readOnly ? null : (
        <Flex
          as="button"
          data-chip-remove
          aria-label={`Remove ${name} emoji from “${target.text}”`}
          title="Remove"
          align="center"
          justify="center"
          boxSize="22px"
          ms="-4px"
          me="2px"
          flexShrink={0}
          borderRadius="6px"
          color="studio.fgSubtle"
          cursor="pointer"
          _hover={{ bg: "studio.raised", color: "studio.fg" }}
          onClick={() => lines.get()?.editor.place(target, null)}
        >
          <X size={12} />
        </Flex>
      )}
    </Flex>
  );
});

function LineAddButton({ shown, lines, lineIndices }: { shown: boolean; lines: CaptionEmojiLines; lineIndices: readonly CaptionEmojiSpan[] }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const expanded = useEmojiPickerOpenFor(element);
  return (
    <Flex
      ref={setElement}
      as="button"
      data-line-actions={shown ? undefined : ""}
      aria-label="Add emoji to this line"
      title="Add emoji"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      // A hover action stays visible while its picker is open (the row's hover reveal would hide it).
      css={{ "&[aria-expanded=true]": { opacity: "1 !important", background: "var(--chakra-colors-studio-raised)", color: "var(--chakra-colors-studio-fg)" } }}
      align="center"
      justify="center"
      flexShrink={0}
      boxSize="26px"
      borderRadius="8px"
      bg={shown ? "studio.subtle" : "transparent"}
      color={shown ? "studio.fgMuted" : "studio.fgSubtle"}
      cursor="pointer"
      transition="background 120ms ease, color 120ms ease, opacity 120ms ease"
      _hover={{ bg: "studio.raised", color: "studio.fg" }}
      onClick={(event: React.MouseEvent<HTMLElement>) => openLineAddPicker(event.currentTarget, lines, lineIndices)}
    >
      <SmilePlus size={14} />
    </Flex>
  );
}

/**
 * A subtitle line's emojis as chips (the art plus the word it sits on), and the action that adds
 * one. With emojis on, a line without an emoji always shows the add button, in the spot and size of
 * the chip that replaces it (the row does not shift); otherwise it is a row hover action. Chips
 * stand left to right as the caption draws their words. The row re-renders only when its own
 * chips change (`useCaptionEmojiLine`).
 */
export function LineEmojiChips({
  store,
  lines,
  direction,
}: {
  store: CaptionEmojiLines;
  /** Transcript slice positions: one line, or a paragraph's lines. */
  lines: readonly CaptionEmojiSpan[];
  direction: "ltr" | "rtl";
}) {
  const view = useCaptionEmojiLine(store, lines, direction);
  if (!view || (view.chips.length === 0 && !view.canAdd)) return null;
  return (
    <Flex ms="auto" align="center" gap="1" minW="0">
      {view.canAdd ? <LineAddButton shown={view.enabled && view.chips.length === 0} lines={store} lineIndices={lines} /> : null}
      {view.chips.length > 0 ? (
        <Flex gap="4px" wrap="wrap" minW="0" dir="ltr" role="group" aria-label="Emojis on this line">
          {view.chips.map((chip) => (
            <LineChip key={chip.target.key} chip={chip} palette={view.palette} readOnly={view.readOnly} lines={store} direction={direction} />
          ))}
        </Flex>
      ) : null}
    </Flex>
  );
}
