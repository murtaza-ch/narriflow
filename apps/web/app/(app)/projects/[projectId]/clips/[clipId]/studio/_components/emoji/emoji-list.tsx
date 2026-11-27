"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { X } from "lucide-react";
import { formatDuration } from "@/lib/format";
import type { CaptionTimeSource } from "../caption-block-painter";
import { captionEmojiListRows, currentCaptionEmojiRow, type CaptionEmojiListRow } from "./caption-emoji-list";
import { openPickerFor } from "./emoji-chips";
import { EmojiGlyph, type CaptionEmojiLook } from "./emoji-glyph";
import { useEmojiPickerOpenFor } from "./emoji-picker-host";
import type { CaptionEmojiEditor } from "./use-caption-emojis";
import { captionEmojiName, useCaptionEmojiIndex } from "./use-caption-emoji-index";

/** The playhead and seeking on the composite (preview) clock; rows hold base edited seconds. */
export interface EmojiListTimeline {
  readonly clock: CaptionTimeSource;
  readonly toBaseEdited: (sec: number) => number;
  readonly toComposite: (editedSec: number) => number;
  readonly seek: (compositeSec: number) => void;
}

/** The row under the playhead; state changes only when it does. */
function useCurrentRow(rows: readonly CaptionEmojiListRow[], timeline: EmojiListTimeline): number {
  const { clock, toBaseEdited } = timeline;
  const read = () => currentCaptionEmojiRow(rows, toBaseEdited(clock.getSnapshot()));
  const [current, setCurrent] = useState(read);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` closes over exactly these.
  useEffect(() => {
    const update = () => setCurrent(read());
    update();
    return clock.subscribe(update);
  }, [rows, clock, toBaseEdited]);
  return current;
}

function EmojiListRow({
  row,
  palette,
  current,
  editor,
  timeline,
}: {
  row: CaptionEmojiListRow;
  palette: CaptionEmojiLook;
  current: boolean;
  editor: CaptionEmojiEditor;
  timeline: EmojiListTimeline;
}) {
  const { target } = row;
  const index = useCaptionEmojiIndex();
  const name = captionEmojiName(index, target.current.id).toLowerCase();
  const time = formatDuration(timeline.toComposite(row.startSec));
  // The picker sits beside the row and gives focus back to it on close.
  const [element, setElement] = useState<HTMLElement | null>(null);
  const expanded = useEmojiPickerOpenFor(element);
  const lit = current || expanded;
  return (
    <Flex
      ref={setElement}
      role="listitem"
      tabIndex={-1}
      aria-current={current || undefined}
      align="center"
      gap="1"
      h="34px"
      ps="1"
      pe="2"
      borderRadius="10px"
      bg={lit ? "studio.accentSubtle" : "studio.subtle"}
      color={lit ? "studio.accentFg" : "studio.fg"}
      outline="none"
      transition="background 120ms ease"
      _hover={lit ? undefined : { bg: "studio.raised" }}
      css={{
        "& [data-row-remove]": { opacity: 0 },
        "&:hover [data-row-remove], &:focus-within [data-row-remove]": { opacity: 1 },
        "&:hover [data-row-time], &:focus-within [data-row-time]": { opacity: 0 },
      }}
    >
      <Flex
        as="button"
        aria-label={`${name} emoji on “${target.text}”, change`}
        title="Change emoji"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        align="center"
        justify="center"
        boxSize="28px"
        flexShrink={0}
        borderRadius="8px"
        cursor="pointer"
        _hover={{ bg: "studio.borderStrong" }}
        _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "-2px" }}
        onClick={() => element && openPickerFor(element, editor, target)}
      >
        <EmojiGlyph id={target.current.id} tone={target.current.tone} palette={palette} size={22} />
      </Flex>
      <Flex
        as="button"
        aria-label={`Go to “${target.text}” at ${time}`}
        flex="1"
        minW="0"
        h="full"
        align="center"
        ps="1.5"
        borderRadius="8px"
        cursor="pointer"
        _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "-2px" }}
        onClick={() => timeline.seek(timeline.toComposite(row.startSec))}
      >
        <Text as="span" dir="auto" truncate fontSize="13px" textAlign="start">
          {target.text}
        </Text>
      </Flex>
      {/* The time stands at the row's end; on hover or focus Remove takes its place. */}
      <Box position="relative" flexShrink={0} w="40px" h="full">
        <Text
          data-row-time
          as="span"
          position="absolute"
          insetEnd="0"
          top="50%"
          transform="translateY(-50%)"
          fontSize="12px"
          color={lit ? "studio.accentFg" : "studio.fgSubtle"}
          fontVariantNumeric="tabular-nums"
          transition="opacity 120ms ease"
        >
          {time}
        </Text>
        <Flex
          data-row-remove
          as="button"
          aria-label={`Remove ${name} emoji from “${target.text}”`}
          title="Remove"
          position="absolute"
          insetEnd="-4px"
          top="50%"
          transform="translateY(-50%)"
          align="center"
          justify="center"
          boxSize="26px"
          borderRadius="7px"
          color="studio.fgMuted"
          cursor="pointer"
          transition="opacity 120ms ease"
          _hover={{ bg: "studio.borderStrong", color: "studio.fg" }}
          onClick={() => editor.place(target, null)}
        >
          <X size={13} />
        </Flex>
      </Box>
    </Flex>
  );
}

/**
 * "In this clip": every emoji the video draws, in time order. A row seeks to its word, its emoji
 * opens the picker to change it, and Remove takes it off in one undo step.
 */
export function EmojiList({ editor, timeline }: { editor: CaptionEmojiEditor; timeline: EmojiListTimeline }) {
  const rows = useMemo(() => captionEmojiListRows(editor.model, editor.placement), [editor.model, editor.placement]);
  const current = useCurrentRow(rows, timeline);
  if (rows.length === 0) {
    return (
      <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5">
        No emojis yet. Add with AI, or tap a word below.
      </Text>
    );
  }
  return (
    <Stack gap="1" role="list" aria-label="Emojis in this clip">
      {rows.map((row, at) => (
        <EmojiListRow key={row.target.key} row={row} palette={editor.palette} current={at === current} editor={editor} timeline={timeline} />
      ))}
    </Stack>
  );
}
