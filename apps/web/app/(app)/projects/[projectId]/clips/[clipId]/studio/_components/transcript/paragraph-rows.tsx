"use client";

import { memo, useCallback } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { RowTextField, textAttributes } from "./row-text-field";
import { formatParagraphTime, type ParagraphRowModel } from "./transcript-rows";

export interface ParagraphRowActions {
  readonly seek: (sec: number) => void;
  /** Rewrites a paragraph's utterances (`replaceSubtitleParagraphText`). */
  readonly edit: (lines: readonly number[], text: string) => void;
}

/** The paragraph's emoji chips (below its text) or its add button (at its right edge). */
export type ParagraphEmojiSlot = (row: ParagraphRowModel, direction: "ltr" | "rtl", part: "chips" | "add") => React.ReactNode;

/** One paragraph: its start in a left column, its text beside it, and its emoji chips (each names its word). */
export const ParagraphRow = memo(function ParagraphRow({
  row,
  active,
  readOnly,
  language,
  query,
  actions,
  emoji,
}: {
  row: ParagraphRowModel;
  active: boolean;
  readOnly: boolean;
  language: string | null;
  query: string;
  actions: ParagraphRowActions;
  emoji: ParagraphEmojiSlot;
}) {
  const { seek, edit } = actions;
  const direction = textAttributes(row.text, language).dir;
  const beginEdit = useCallback(() => {
    const lines = row.lines;
    return (text: string) => edit(lines, text);
  }, [edit, row.lines]);
  return (
    <Flex
      data-row-key={row.id}
      role="listitem"
      aria-current={active || undefined}
      dir="ltr"
      align="flex-start"
      gap="10px"
      mx="8px"
      px="12px"
      py="6px"
      borderRadius="10px"
      bg={active ? "studio.accentSubtle" : "transparent"}
      transition="background 150ms ease"
      css={{
        contentVisibility: "auto",
        containIntrinsicSize: "auto 96px",
        "& [data-row-actions]": { opacity: 0, transition: "opacity 120ms ease" },
        "&:hover [data-row-actions], &:focus-within [data-row-actions]": { opacity: 1 },
      }}
    >
      <Text
        as="button"
        flexShrink={0}
        w="40px"
        pt="3px"
        textAlign="start"
        fontSize="11.5px"
        lineHeight="1.8"
        fontVariantNumeric="tabular-nums"
        color={active ? "studio.accentFg" : "studio.fgSubtle"}
        aria-label={`Play from ${formatParagraphTime(row.startSec)}`}
        onClick={() => seek(row.startSec)}
        _hover={{ color: "studio.fg" }}
      >
        {formatParagraphTime(row.startSec)}
      </Text>
      <Box flex="1" minW="0">
        <RowTextField
          value={row.text}
          label={`Paragraph at ${formatParagraphTime(row.startSec)}`}
          language={language}
          readOnly={readOnly}
          query={query}
          lineHeight="1.8"
          submit="mod-enter"
          beginEdit={beginEdit}
        />
        {emoji(row, direction, "chips")}
      </Box>
      <Flex flexShrink={0} minW="32px" justify="flex-end">
        {emoji(row, direction, "add")}
      </Flex>
    </Flex>
  );
});

/** The Paragraph view, as in Vizard: times on the left, paragraphs beside them. */
export function ParagraphRowList({
  rows,
  active,
  readOnly,
  language,
  query,
  actions,
  emoji,
}: {
  rows: readonly ParagraphRowModel[];
  /** The active row's id, or null. */
  active: string | null;
  readOnly: boolean;
  language: string | null;
  query: string;
  actions: ParagraphRowActions;
  emoji: ParagraphEmojiSlot;
}) {
  return (
    <Box role="list" aria-label="Paragraphs">
      {rows.map((row) => (
        <ParagraphRow key={row.id} row={row} active={row.id === active} readOnly={readOnly} language={language} query={query} actions={actions} emoji={emoji} />
      ))}
    </Box>
  );
}
