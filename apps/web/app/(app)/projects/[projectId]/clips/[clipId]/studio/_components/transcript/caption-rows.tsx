"use client";

import { memo, useCallback } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Combine, Plus, Trash2 } from "lucide-react";
import type { CaptionRowAddress } from "../subtitle-lines";
import { RowTextField, textAttributes } from "./row-text-field";
import { formatCaptionTime, type CaptionRowModel } from "./transcript-rows";

export interface CaptionRowActions {
  /** Composition seconds. */
  readonly seek: (sec: number) => void;
  readonly edit: (row: CaptionRowAddress, text: string) => void;
  readonly addAfter: (row: CaptionRowAddress) => void;
  readonly remove: (row: CaptionRowAddress) => void;
  readonly mergeNext: (row: CaptionRowAddress, next: CaptionRowAddress) => void;
}

/** The row's emoji buttons; the panel supplies the Studio's, the prototype and tests their own. */
export type RowEmojiSlot = (row: CaptionRowModel, direction: "ltr" | "rtl") => React.ReactNode;

function RowAction({ label, onClick, disabled = false, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Flex
      as="button"
      align="center"
      justify="center"
      boxSize="24px"
      borderRadius="6px"
      color="studio.fgSubtle"
      aria-label={label}
      title={label}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      _hover={{ bg: "studio.raised", color: "studio.fg" }}
      _disabled={{ opacity: 0.35, cursor: "default", bg: "transparent", color: "studio.fgSubtle" }}
    >
      {children}
    </Flex>
  );
}

const isControl = (target: EventTarget | null) => target instanceof Element && target.closest("button, textarea, input, [role=dialog]") !== null;

/**
 * One caption as it appears on the video: its time range on top, its text below, and its emoji
 * button at the right edge (the same side in right-to-left text, as in Vizard's list). Clicking the
 * time or the row's empty space seeks to the caption; so does focusing its text.
 */
export const CaptionRow = memo(function CaptionRow({
  row,
  active,
  readOnly,
  language,
  query,
  actions,
  emoji,
}: {
  row: CaptionRowModel;
  active: boolean;
  readOnly: boolean;
  language: string | null;
  query: string;
  actions: CaptionRowActions;
  emoji: RowEmojiSlot;
}) {
  const { seek, edit, addAfter, remove, mergeNext } = actions;
  const beginEdit = useCallback(() => {
    seek(row.startSec);
    const address = row.address;
    return (text: string) => edit(address, text);
  }, [edit, row.address, row.startSec, seek]);
  const direction = textAttributes(row.text, language).dir;
  return (
    <Flex
      data-row-key={row.id}
      role="listitem"
      aria-current={active || undefined}
      dir="ltr"
      align="center"
      gap="12px"
      mx="8px"
      px="12px"
      py="8px"
      borderRadius="10px"
      bg={active ? "studio.accentSubtle" : "transparent"}
      transition="background 150ms ease"
      cursor="pointer"
      css={{
        contentVisibility: "auto",
        containIntrinsicSize: "auto 64px",
        "& [data-row-actions]": { opacity: 0, transition: "opacity 120ms ease" },
        "&:hover [data-row-actions], &:focus-within [data-row-actions]": { opacity: 1 },
      }}
      onClick={(event: React.MouseEvent) => {
        if (!isControl(event.target)) seek(row.startSec);
      }}
    >
      <Box flex="1" minW="0">
        <Flex align="center" gap="6px" h="24px">
          <Text
            as="span"
            fontSize="12px"
            color={active ? "studio.accentFg" : "studio.fgSubtle"}
            fontVariantNumeric="tabular-nums"
            whiteSpace="nowrap"
          >
            {formatCaptionTime(row.startSec)} – {formatCaptionTime(row.endSec)}
          </Text>
          {readOnly ? null : (
            <Flex data-row-actions align="center" gap="1px">
              <RowAction label="Add caption after" onClick={() => addAfter(row.address)}>
                <Plus size={14} />
              </RowAction>
              <RowAction label="Merge with next" disabled={!row.mergeable} onClick={() => row.next && mergeNext(row.address, row.next)}>
                <Combine size={14} />
              </RowAction>
              <RowAction label="Delete caption" onClick={() => remove(row.address)}>
                <Trash2 size={13} />
              </RowAction>
            </Flex>
          )}
        </Flex>
        <RowTextField
          value={row.text}
          label={`Caption at ${formatCaptionTime(row.startSec)}`}
          language={language}
          readOnly={readOnly}
          query={query}
          lineHeight="1.6"
          submit="enter"
          beginEdit={beginEdit}
        />
      </Box>
      <Flex flexShrink={0} minW="32px" justify="flex-end">
        {emoji(row, direction)}
      </Flex>
    </Flex>
  );
});

/** The Sentence view: one row per caption, top to bottom as they play. */
export function CaptionRowList({
  rows,
  active,
  readOnly,
  language,
  query,
  actions,
  emoji,
}: {
  rows: readonly CaptionRowModel[];
  /** The active row's id, or null. */
  active: string | null;
  readOnly: boolean;
  language: string | null;
  query: string;
  actions: CaptionRowActions;
  emoji: RowEmojiSlot;
}) {
  return (
    <Box role="list" aria-label="Captions">
      {rows.map((row) => (
        <CaptionRow
          key={row.id}
          row={row}
          active={row.id === active}
          readOnly={readOnly}
          language={language}
          query={query}
          actions={actions}
          emoji={emoji}
        />
      ))}
    </Box>
  );
}
