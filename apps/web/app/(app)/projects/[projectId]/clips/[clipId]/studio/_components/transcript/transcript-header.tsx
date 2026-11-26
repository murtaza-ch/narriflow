"use client";

import { Box, Button, Flex, Input, Text } from "@chakra-ui/react";
import { Search, ShieldCheck, X } from "lucide-react";

export type TranscriptViewMode = "word" | "sentence" | "paragraph";

const VIEW_LABELS: Record<TranscriptViewMode, string> = { word: "Word", sentence: "Sentence", paragraph: "Paragraph" };

function ViewModeButton({ mode, current, onSelect }: { mode: TranscriptViewMode; current: TranscriptViewMode; onSelect: (mode: TranscriptViewMode) => void }) {
  const selected = mode === current;
  return (
    <Box
      as="button"
      position="relative"
      h="26px"
      bg="transparent"
      color={selected ? "studio.fg" : "studio.fgSubtle"}
      fontSize="13px"
      fontWeight={selected ? "600" : "500"}
      aria-pressed={selected}
      onClick={() => onSelect(mode)}
      transition="color 120ms ease"
      _hover={{ color: "studio.fg" }}
    >
      {VIEW_LABELS[mode]}
      {/* Underline marks the active view — no box around it */}
      {selected ? <Box position="absolute" left="0" right="0" bottom="-1px" h="2px" borderRadius="full" bg="studio.accent" /> : null}
    </Box>
  );
}

export interface TranscriptSearchState {
  readonly value: string;
  /** Rows holding the query, and which one Enter went to last (0-based; -1 before the first Enter). */
  readonly matches: number;
  readonly cursor: number;
  readonly onChange: (value: string) => void;
  readonly onNext: () => void;
}

/** Narriflow's borderless soft field: a fill step on focus, never a ring. */
function SearchField({ search }: { search: TranscriptSearchState }) {
  const { value, matches, cursor, onChange, onNext } = search;
  return (
    <Flex
      align="center"
      gap="8px"
      h="34px"
      px="10px"
      flex="1"
      minW="0"
      bg="studio.subtle"
      borderRadius="10px"
      color="studio.fgSubtle"
      transition="background 120ms ease"
      _focusWithin={{ bg: "studio.raised" }}
    >
      <Search size={14} style={{ flexShrink: 0 }} />
      <Input
        aria-label="Search captions"
        placeholder="Search"
        value={value}
        maxLength={120}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            onNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onChange("");
          }
        }}
        h="full"
        p="0"
        border="0"
        outline="0"
        bg="transparent"
        fontSize="13px"
        color="studio.fg"
        focusVisibleRing="none"
        _focusVisible={{ boxShadow: "none" }}
        _placeholder={{ color: "studio.fgSubtle" }}
      />
      {value ? (
        <>
          <Text
            as="span"
            fontSize="12px"
            color="studio.fgSubtle"
            whiteSpace="nowrap"
            fontVariantNumeric="tabular-nums"
            aria-live="polite"
            aria-label={matches === 0 ? "No matches" : cursor >= 0 ? `Match ${cursor + 1} of ${matches}` : `${matches} ${matches === 1 ? "match" : "matches"}`}
          >
            {matches === 0 ? "None" : cursor >= 0 ? `${cursor + 1}/${matches}` : matches}
          </Text>
          <Flex
            as="button"
            aria-label="Clear search"
            align="center"
            justify="center"
            boxSize="22px"
            flexShrink={0}
            borderRadius="6px"
            color="studio.fgSubtle"
            onClick={() => onChange("")}
            _hover={{ bg: "studio.borderStrong", color: "studio.fg" }}
          >
            <X size={13} />
          </Flex>
        </>
      ) : null}
    </Flex>
  );
}

/** View switch, quiet language, search (Sentence and Paragraph) and Auto-censor. */
export function TranscriptHeader({
  view,
  onViewChange,
  languageLabel,
  search,
  onAutoCensor,
}: {
  view: TranscriptViewMode;
  onViewChange: (mode: TranscriptViewMode) => void;
  languageLabel: string | null;
  /** Null in the Word view, which has no rows to filter. */
  search: TranscriptSearchState | null;
  onAutoCensor: () => void;
}) {
  return (
    <Flex px="20px" pt="10px" pb="8px" direction="column" align="stretch" flexShrink={0} gap="10px">
      <Flex align="center" justify="space-between" gap="3">
        <Flex role="group" aria-label="Transcript editing view" gap="4">
          <ViewModeButton mode="word" current={view} onSelect={onViewChange} />
          <ViewModeButton mode="sentence" current={view} onSelect={onViewChange} />
          <ViewModeButton mode="paragraph" current={view} onSelect={onViewChange} />
        </Flex>
        {languageLabel ? (
          <Text fontSize="12px" color="studio.fgSubtle" truncate>
            {languageLabel}
          </Text>
        ) : null}
      </Flex>
      <Flex align="center" gap="2">
        {search ? <SearchField search={search} /> : null}
        <Button
          size="sm"
          variant="ghost"
          color="studio.fg"
          px="2"
          ms={search ? undefined : "-2"}
          flexShrink={0}
          _hover={{ bg: "studio.subtle" }}
          onClick={onAutoCensor}
        >
          <ShieldCheck size={15} /> Auto-censor
        </Button>
      </Flex>
    </Flex>
  );
}
