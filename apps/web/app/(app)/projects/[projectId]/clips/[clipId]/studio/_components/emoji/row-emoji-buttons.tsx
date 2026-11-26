"use client";

import { memo, useState } from "react";
import { Flex } from "@chakra-ui/react";
import { SmilePlus, Trash2 } from "lucide-react";
import type { CaptionEmojiPalette } from "@narriflow/validators";
import { useCaptionEmojiLine, type CaptionEmojiLines, type LineEmojiChipView } from "./caption-emoji-lines";
import type { CaptionEmojiSpan } from "./caption-emoji-words";
import { HIDDEN_REASONS, LineChip, openLineAddPicker, openLineEmojiChip } from "./emoji-chips";
import { EmojiGlyph } from "./emoji-glyph";
import { useEmojiPickerOpenFor } from "./emoji-picker-host";
import { captionEmojiName, useCaptionEmojiIndex } from "./use-caption-emoji-index";

// The emoji button at a caption row's right edge, as in Vizard's subtitle list: a square holding
// the caption's emoji (pressing it opens the picker: replace, move to another word of the caption,
// remove), with a remove control beside it on hover or focus; or the add icon when the caption has
// none. The row re-renders only when its own emojis change (`useCaptionEmojiLine`).

const BUTTON = "32px";

/** Square soft button; a hover action stays visible while its picker is open. */
const squareProps = (expanded: boolean) =>
  ({
    align: "center",
    justify: "center",
    flexShrink: 0,
    boxSize: BUTTON,
    borderRadius: "8px",
    bg: expanded ? "studio.accentSubtle" : "studio.subtle",
    color: expanded ? "studio.accentFg" : "studio.fgMuted",
    cursor: "pointer",
    transition: "background 120ms ease, color 120ms ease, opacity 120ms ease",
    _hover: expanded ? undefined : { bg: "studio.raised", color: "studio.fg" },
  }) as const;

const RowEmojiButton = memo(function RowEmojiButton({
  chip,
  palette,
  readOnly,
  store,
  spans,
  direction,
}: {
  chip: LineEmojiChipView;
  palette: CaptionEmojiPalette;
  readOnly: boolean;
  store: CaptionEmojiLines;
  spans: readonly CaptionEmojiSpan[];
  direction: "ltr" | "rtl";
}) {
  const { target, hidden } = chip;
  const index = useCaptionEmojiIndex();
  const name = captionEmojiName(index, target.current!.id).toLowerCase();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const expanded = useEmojiPickerOpenFor(element);
  const reason = hidden ? HIDDEN_REASONS[hidden] : null;
  return (
    <Flex
      position="relative"
      flexShrink={0}
      css={{ "& [data-emoji-remove]": { display: "none" }, "&:hover [data-emoji-remove], &:focus-within [data-emoji-remove]": { display: "flex" } }}
    >
      {readOnly ? null : (
        // Beside the button, over the row's text, so showing it never reflows the row.
        <Flex
          as="button"
          data-emoji-remove
          aria-label={`Remove ${name} emoji from “${target.text}”`}
          title="Remove emoji"
          position="absolute"
          insetEnd="100%"
          top="0"
          me="6px"
          {...squareProps(false)}
          bg="studio.raised"
          _hover={{ bg: "studio.borderStrong", color: "studio.fg" }}
          onClick={() => store.get()?.editor.place(target, null)}
        >
          <Trash2 size={15} />
        </Flex>
      )}
      <Flex
        ref={setElement}
        as={readOnly ? "span" : "button"}
        aria-label={readOnly ? `${name} emoji on “${target.text}”` : `${name} emoji on “${target.text}”, change${reason ? `. ${reason}` : ""}`}
        aria-haspopup={readOnly ? undefined : "dialog"}
        aria-expanded={readOnly ? undefined : expanded}
        title={reason ?? `${name} on “${target.text}”`}
        {...squareProps(expanded)}
        cursor={readOnly ? "default" : "pointer"}
        opacity={hidden ? 0.5 : 1}
        onClick={readOnly ? undefined : (event: React.MouseEvent<HTMLElement>) => openLineEmojiChip(event.currentTarget, store, target, direction, spans)}
      >
        <EmojiGlyph id={target.current!.id} tone={target.current!.tone} palette={palette} size={20} />
      </Flex>
    </Flex>
  );
});

function RowAddButton({ shown, store, spans }: { shown: boolean; store: CaptionEmojiLines; spans: readonly CaptionEmojiSpan[] }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const expanded = useEmojiPickerOpenFor(element);
  return (
    <Flex
      ref={setElement}
      as="button"
      data-row-actions={shown ? undefined : ""}
      aria-label="Add emoji to this caption"
      title="Add emoji"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      css={{ "&[aria-expanded=true]": { opacity: "1 !important" } }}
      {...squareProps(expanded)}
      bg={expanded ? "studio.accentSubtle" : shown ? "studio.subtle" : "transparent"}
      onClick={(event: React.MouseEvent<HTMLElement>) => openLineAddPicker(event.currentTarget, store, spans)}
    >
      <SmilePlus size={16} />
    </Flex>
  );
}

/**
 * A caption row's emoji buttons. With emojis on: one button per emoji on the caption, or the add icon
 * when it has none, always visible. With emojis off: the add icon on row hover only (adding turns
 * emojis on). Read-only rows show their emojis and offer nothing.
 */
export function RowEmojiButtons({
  store,
  spans,
  direction,
}: {
  store: CaptionEmojiLines;
  /** The caption's words. */
  spans: readonly CaptionEmojiSpan[];
  direction: "ltr" | "rtl";
}) {
  const view = useCaptionEmojiLine(store, spans, direction);
  if (!view) return null;
  if (view.chips.length > 0) {
    return (
      // Stacked, so every button stays on the row's right edge and each remove control sits over the text.
      <Flex direction="column" gap="6px" flexShrink={0} dir="ltr" role="group" aria-label="Emojis on this caption">
        {view.chips.map((chip) => (
          <RowEmojiButton key={chip.target.key} chip={chip} palette={view.palette} readOnly={view.readOnly} store={store} spans={spans} direction={direction} />
        ))}
      </Flex>
    );
  }
  return view.canAdd ? <RowAddButton shown={view.enabled} store={store} spans={spans} /> : null;
}

/** A paragraph's emojis as chips naming their words (a paragraph holds many captions), below its text. */
export function ParagraphEmojiChips({ store, spans, direction }: { store: CaptionEmojiLines; spans: readonly CaptionEmojiSpan[]; direction: "ltr" | "rtl" }) {
  const view = useCaptionEmojiLine(store, spans, direction);
  if (!view || view.chips.length === 0) return null;
  return (
    <Flex gap="4px" wrap="wrap" mt="4px" dir="ltr" role="group" aria-label="Emojis in this paragraph">
      {view.chips.map((chip) => (
        <LineChip key={chip.target.key} chip={chip} palette={view.palette} readOnly={view.readOnly} lines={store} direction={direction} />
      ))}
    </Flex>
  );
}

/** A paragraph's add button at its right edge, on hover: the Paragraph view reads as text, as in Vizard's. */
export function ParagraphEmojiAdd({ store, spans, direction }: { store: CaptionEmojiLines; spans: readonly CaptionEmojiSpan[]; direction: "ltr" | "rtl" }) {
  const view = useCaptionEmojiLine(store, spans, direction);
  return view?.canAdd ? <RowAddButton shown={false} store={store} spans={spans} /> : null;
}
