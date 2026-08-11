"use client";

import { useState } from "react";
import { Box, Flex, Text, HStack } from "@chakra-ui/react";
import { ArrowLeft, Undo2, Redo2, Keyboard, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { ScoreMeter, Spinner } from "@narriflow/ui";
import { formatDuration } from "@/lib/format";
import { ClipActionsMenu } from "../../../../clip-actions-menu";
import { useStudio, type StudioSaveState } from "./studio-shell";
import { ResetConfirmDialog } from "./reset-confirm-dialog";
import { StudioExportMenu } from "./studio-export-menu";

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
 * additionally surface as an error toast from the shell. 'blocked' is a
 * distinct, non-retryable state (a 409/422 that only clears on reload) — it
 * gets its own copy rather than falling back to the generic "Save failed" so
 * the user knows retrying won't help.
 */
function AutosaveIndicator({
  saveState,
  isDocDirty,
}: {
  saveState: StudioSaveState;
  isDocDirty: boolean;
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

  const isBlocked = saveState === "blocked";
  const isError = saveState === "error" || isBlocked;
  const isLocal = saveState === "local";
  const isOffline = saveState === "offline";
  const isReadonly = saveState === "readonly";
  // Live-QA finding 2026-08-06: 'idle' alone is NOT proof the document is
  // saved — a failed save times back to idle after 4s with the retry still
  // pending, and the debounce window before the first PUT is also 'idle'.
  // Claiming "Saved" while dirty is a silent-data-loss message; consult the
  // dirty flag and say so honestly instead.
  const idleButDirty = !isError && isDocDirty;
  return (
    <HStack gap="6px" aria-live="polite">
      <Box
        w="6px"
        h="6px"
        borderRadius="full"
        bg={
          isError
            ? "danger.solid"
            : isOffline || isLocal
              ? "accent.solid"
            : idleButDirty
              ? "studio.fgSubtle"
              : saveState === "saved"
                ? "success.solid"
                : "studio.fgSubtle"
        }
      />
      <Text fontSize="12px" color={isError ? "danger.fg" : "studio.fgMuted"}>
        {isBlocked
          ? "Save needs attention"
          : isReadonly
            ? "Read-only tab"
          : isOffline
            ? "Saved offline"
          : isLocal
            ? "Saved on this device"
          : isError
            ? "Save failed"
            : idleButDirty
              ? "Unsaved changes…"
              : "Saved"}
      </Text>
    </HStack>
  );
}

export function TopBar() {
  const router = useRouter();
  const {
    clipInfo,
    canUndo,
    canRedo,
    showShortcuts,
    setShowShortcuts,
    handleUndo,
    handleRedo,
    handleReset,
    resetState,
    canReset,
    saveState,
    isDocDirty,
    aspectRatio,
  } = useStudio();
  const [showResetConfirm, setShowResetConfirm] = useState(false);

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
          onClick={() => router.push(`/projects/${clipInfo.projectId}`)}
          label="Back to project"
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
          {clipInfo.clipTitle ?? clipInfo.title}
        </Text>

        {/* Same overflow menu as the clip rows, so a rename is reachable from
            wherever the title is showing. Duplicate/delete both navigate:
            editing a copy is the point of duplicating from in here, and the
            studio can't stay open on a clip that no longer exists. */}
        <ClipActionsMenu
          projectId={clipInfo.projectId}
          clipId={clipInfo.id}
          title={clipInfo.clipTitle}
          fallbackTitle={clipInfo.title}
          surface="studio"
          onDuplicated={(clip) =>
            router.push(`/projects/${clip.projectId}/clips/${clip.id}/studio`)
          }
          onDeleted={() => router.push(`/projects/${clipInfo.projectId}`)}
        />

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
        <AutosaveIndicator saveState={saveState} isDocDirty={isDocDirty} />

        <Box w="1px" h="20px" bg="studio.border" mx="1" />

        <IconBtn
          icon={<Undo2 size={16} />}
          onClick={handleUndo}
          disabled={!canUndo}
          label="Undo (Ctrl+Z)"
        />
        <IconBtn
          icon={<Redo2 size={16} />}
          onClick={handleRedo}
          disabled={!canRedo}
          label="Redo (Ctrl+Shift+Z)"
        />
        <IconBtn
          icon={<RotateCcw size={16} />}
          onClick={() => setShowResetConfirm(true)}
          disabled={!canReset || resetState === "resetting"}
          label="Reset to original"
        />
        <IconBtn
          icon={<Keyboard size={16} />}
          onClick={() => setShowShortcuts(!showShortcuts)}
          label="Keyboard shortcuts"
        />

        <Box w="1px" h="20px" bg="studio.border" mx="1" />

        <StudioExportMenu />
      </HStack>

      <ResetConfirmDialog
        open={showResetConfirm}
        onOpenChange={setShowResetConfirm}
        confirming={resetState === "resetting"}
        onConfirm={() => {
          void handleReset();
        }}
      />
    </Flex>
  );
}
