"use client";

import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { ChevronRight } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { useStudio } from "../studio-shell";
import { StudioLockGem } from "../studio-lock-gem";
import { useStudioCaptionEmojiEditor } from "../emoji/studio-caption-emojis";
import type { CaptionEmojiEditor } from "../emoji/use-caption-emojis";
import { orderAiToolRows, rowControl, type AiToolRowState } from "./ai-tools/ai-tools-model";
import { useBrollToolRow } from "./ai-tools/broll-row";
import { useCensorToolRow } from "./ai-tools/censor-row";
import { useEmojiToolRow } from "./ai-tools/emoji-row";
import { useEmphasisToolRow } from "./ai-tools/emphasis-row";
import { useFillerToolRow } from "./ai-tools/filler-row";
import { useReframeToolRow } from "./ai-tools/reframe-row";
import { useSilenceToolRow } from "./ai-tools/silence-row";

/**
 * The AI tools panel: one row per AI action the Studio has, each a front door to that tool. Apply
 * rows make the tool's own one-step edit; chevron rows open the tool's panel. Nothing here blocks
 * the list: a running tool shows its progress inside its own button.
 */
export function AiToolsPanel() {
  // Mounted so an emoji answer can commit while this panel is open.
  const emojiEditor = useStudioCaptionEmojiEditor();
  return <AiToolsList emojiEditor={emojiEditor} />;
}

/** The rows over a given emoji editor (the prototype passes one over local state). */
export function AiToolsList({ emojiEditor }: { emojiEditor: CaptionEmojiEditor }) {
  const { editingElsewhere } = useStudio("editingElsewhere");
  const rows = orderAiToolRows([
    useEmojiToolRow(emojiEditor),
    useSilenceToolRow(),
    useFillerToolRow(),
    useReframeToolRow(),
    useCensorToolRow(),
    useEmphasisToolRow(),
    useBrollToolRow(),
  ]);
  return (
    <Stack gap="1" px="3" pb="4" role="list" aria-label="AI tools">
      {rows.map((row) => (
        <AiToolRow key={row.id} row={row} readOnly={editingElsewhere} />
      ))}
    </Stack>
  );
}

function ApplyButton({ title, busy, onApply }: { title: string; busy: boolean; onApply: () => void }) {
  return (
    <Flex
      as="button"
      flexShrink={0}
      minW="72px"
      h="32px"
      px="3.5"
      align="center"
      justify="center"
      borderRadius="8px"
      bg="studio.raised"
      border="none"
      color="studio.fg"
      fontSize="13px"
      fontWeight="500"
      cursor={busy ? "progress" : "pointer"}
      aria-label={busy ? `${title}, working` : title}
      aria-busy={busy}
      aria-disabled={busy}
      transition="background 120ms ease"
      _hover={busy ? undefined : { bg: "studio.borderStrong" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "1px" }}
      onClick={busy ? undefined : onApply}
    >
      {busy ? <Spinner size="sm" color="studio.fg" /> : "Apply"}
    </Flex>
  );
}

function RowText({ row }: { row: AiToolRowState }) {
  return (
    <Stack gap="1.5" minW="0" flex="1" align="flex-start">
      <Box color="studio.fgMuted" aria-hidden>
        {row.icon}
      </Box>
      <Box>
        <Flex align="center" gap="1.5">
          <Text fontSize="14px" fontWeight="500" color="studio.fg" lineHeight="1.4">
            {row.title}
          </Text>
          {row.gem ? <StudioLockGem tier={row.gem} /> : null}
        </Flex>
        <Text fontSize="12.5px" color="studio.fgMuted" lineHeight="1.45" fontVariantNumeric="tabular-nums">
          {row.description}
        </Text>
        {row.note ? (
          <Text fontSize="12px" color="studio.fgSubtle" lineHeight="1.45" mt="1">
            {row.note}
          </Text>
        ) : null}
      </Box>
    </Stack>
  );
}

function RowError({ error }: { error: NonNullable<AiToolRowState["error"]> }) {
  return (
    <Flex mt="2.5" px="3" py="2" gap="3" align="center" justify="space-between" bg="studio.subtle" borderRadius="10px" role="alert">
      <Text fontSize="12px" color="studio.danger" lineHeight="1.5">
        {error.message}
      </Text>
      {error.onRetry ? (
        <Box as="button" flexShrink={0} h="28px" px="2.5" borderRadius="8px" bg="studio.raised" color="studio.fg" fontSize="12px" fontWeight="500" cursor="pointer" _hover={{ bg: "studio.borderStrong" }} onClick={error.onRetry}>
          Try again
        </Box>
      ) : null}
    </Flex>
  );
}

function AiToolRow({ row, readOnly }: { row: AiToolRowState; readOnly: boolean }) {
  const control = rowControl(row.control, readOnly);
  const error = row.error && !readOnly ? <RowError error={row.error} /> : null;
  if (control.kind === "open") {
    // The whole row opens the tool, as its chevron says.
    return (
      <Box role="listitem">
        <Flex
          as="button"
          w="full"
          px="2"
          py="3"
          gap="3"
          align="center"
          textAlign="start"
          borderRadius="12px"
          bg="transparent"
          border="none"
          cursor="pointer"
          transition="background 120ms ease"
          _hover={{ bg: "studio.subtle" }}
          _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "-2px" }}
          onClick={control.onOpen}
        >
          <RowText row={row} />
          <Flex align="center" gap="1.5" flexShrink={0} color="studio.fgMuted">
            {control.status ? (
              <Text fontSize="13px" fontWeight="500" color="studio.fgMuted">
                {control.status}
              </Text>
            ) : null}
            <ChevronRight size={18} aria-hidden />
          </Flex>
        </Flex>
        {error ? <Box px="2">{error}</Box> : null}
      </Box>
    );
  }
  return (
    <Box role="listitem" px="2" py="3">
      <Flex gap="3" align="center">
        <RowText row={row} />
        {control.kind === "apply" ? <ApplyButton title={row.title} busy={control.busy ?? false} onApply={control.onApply} /> : null}
      </Flex>
      {error}
    </Box>
  );
}
