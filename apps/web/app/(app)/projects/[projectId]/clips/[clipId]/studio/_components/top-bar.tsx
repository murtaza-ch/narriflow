"use client";

import { Box, Flex, Text, HStack } from "@chakra-ui/react";
import { ArrowLeft, Undo2, Redo2, Keyboard, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button, ScoreMeter, Spinner } from "@narriflow/ui";
import { formatDuration } from "@/lib/format";
import { useStudio } from "./studio-shell";

function IconBtn({
  icon,
  onClick,
  disabled,
  label,
}: {
  icon: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Flex
      as="button"
      align="center"
      justify="center"
      w="32px"
      h="32px"
      borderRadius="l1"
      bg="transparent"
      border="none"
      color={disabled ? "fg.disabled" : "studio.fgMuted"}
      cursor={disabled ? "not-allowed" : "pointer"}
      title={label}
      aria-label={label}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      transition="background 120ms ease, color 120ms ease"
      _hover={disabled ? {} : { bg: "studio.raised", color: "studio.fg" }}
    >
      {icon}
    </Flex>
  );
}

/**
 * Ambient autosave indicator — a small status dot plus micro-copy. Failures
 * additionally surface as an error toast from the shell.
 */
function AutosaveIndicator({
  saveState,
}: {
  saveState: "idle" | "saving" | "saved" | "error";
}) {
  if (saveState === "saving") {
    return (
      <HStack gap="6px" aria-live="polite">
        <Spinner size="xs" />
        <Text fontSize="12px" color="studio.fgMuted">
          Saving…
        </Text>
      </HStack>
    );
  }

  const isError = saveState === "error";
  return (
    <HStack gap="6px" aria-live="polite">
      <Box
        w="6px"
        h="6px"
        borderRadius="full"
        bg={
          isError
            ? "danger.solid"
            : saveState === "saved"
              ? "success.solid"
              : "studio.fgSubtle"
        }
      />
      <Text fontSize="12px" color={isError ? "danger.fg" : "studio.fgMuted"}>
        {isError ? "Save failed" : "Saved"}
      </Text>
    </HStack>
  );
}

export function TopBar() {
  const router = useRouter();
  const {
    clipInfo,
    undoStack,
    redoStack,
    showShortcuts,
    setShowShortcuts,
    handleExport,
    handleUndo,
    handleRedo,
    saveState,
    exportState,
    aspectRatio,
  } = useStudio();

  return (
    <Flex
      h="48px"
      align="center"
      px="3"
      gap="1"
      bg="studio.surface"
      borderBottomWidth="1px"
      borderColor="studio.border"
      flexShrink={0}
    >
      {/* Left: back + title + clip data */}
      <HStack gap="2" flex="1" minW="0">
        <IconBtn
          icon={<ArrowLeft size={16} />}
          onClick={() => router.back()}
          label="Back"
        />
        <Text
          fontFamily="display"
          fontSize="13px"
          fontWeight="600"
          color="studio.fg"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
          maxW="300px"
        >
          {clipInfo.title}
        </Text>

        <Box w="1px" h="20px" bg="studio.border" mx="1" flexShrink={0} />

        <HStack gap="2" flexShrink={0} display={{ base: "none", md: "flex" }}>
          <Text textStyle="data" fontSize="12px" color="studio.timecode">
            {formatDuration(clipInfo.duration)}
          </Text>
          <Text textStyle="data" fontSize="12px" color="studio.fgMuted">
            {aspectRatio}
          </Text>
          <ScoreMeter score={clipInfo.viralityScore} size="sm" />
        </HStack>
      </HStack>

      {/* Right: autosave + history + shortcuts + export */}
      <HStack gap="1" flexShrink={0}>
        <AutosaveIndicator saveState={saveState} />

        <Box w="1px" h="20px" bg="studio.border" mx="1" />

        <IconBtn
          icon={<Undo2 size={16} />}
          onClick={handleUndo}
          disabled={undoStack.length === 0}
          label="Undo (Ctrl+Z)"
        />
        <IconBtn
          icon={<Redo2 size={16} />}
          onClick={handleRedo}
          disabled={redoStack.length === 0}
          label="Redo (Ctrl+Shift+Z)"
        />
        <IconBtn
          icon={<Keyboard size={16} />}
          onClick={() => setShowShortcuts(!showShortcuts)}
          label="Keyboard shortcuts"
        />

        <Box w="1px" h="20px" bg="studio.border" mx="1" />

        {/* Export — the one solid button in the studio view */}
        <Button
          size="sm"
          colorPalette="accent"
          variant="solid"
          onClick={exportState === "idle" ? handleExport : undefined}
          loading={exportState === "exporting"}
          loadingText="Exporting…"
          aria-label={`Export ${aspectRatio}`}
        >
          {exportState === "queued" ? (
            <>
              <Check size={13} />
              Queued
            </>
          ) : (
            <>Export {aspectRatio}</>
          )}
        </Button>
      </HStack>
    </Flex>
  );
}
