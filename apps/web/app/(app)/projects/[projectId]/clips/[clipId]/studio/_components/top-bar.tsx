"use client";

import { useState } from "react";
import { Box, Flex, Popover, Portal, Text, HStack } from "@chakra-ui/react";
import { ChevronLeft, ChevronDown, Undo2, Redo2, Keyboard, RotateCcw, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { Spinner } from "@narriflow/ui/components/spinner";
import { ClipActionsMenu } from "../../../../clip-actions-menu";
import { useStudio, type StudioSaveState } from "./studio-shell";
import { ResetConfirmDialog } from "./reset-confirm-dialog";
import { StudioExportMenu } from "./studio-export-menu";
import { SaveIssueBody, type SaveIssueActions } from "./save-issue-panel";
import type { SaveIssue } from "./save-issue";
import { useUpgrade } from "@/app/(app)/_components/upgrade";
import { authEntryHref } from "@/lib/auth-entry";
import { useIsMac } from "./use-is-mac";

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
      w="36px"
      h="36px"
      borderRadius="l2"
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
  saveIssue,
  issueActions,
}: {
  saveState: StudioSaveState;
  isDocDirty: boolean;
  saveIssue?: SaveIssue | null;
  issueActions?: SaveIssueActions;
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
  const isDegraded = saveState === "degraded";
  // Live-QA finding 2026-08-06: 'idle' alone is NOT proof the document is
  // saved — a failed save times back to idle after 4s with the retry still
  // pending, and the debounce window before the first PUT is also 'idle'.
  // Claiming "Saved" while dirty is a silent-data-loss message; consult the
  // dirty flag and say so honestly instead.
  const idleButDirty = !isError && isDocDirty;
  const status = (
    <HStack gap="6px" aria-live="polite">
      <Box
        w="6px"
        h="6px"
        borderRadius="full"
        bg={
          isError
            ? "danger.solid"
            : isOffline || isLocal || isDegraded
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
          : isDegraded
            ? "Cloud safety only"
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
  if (!isBlocked || !saveIssue || !issueActions) return status;
  return <SaveIssuePopover issue={saveIssue} actions={issueActions}>{status}</SaveIssuePopover>;
}

/** The blocked save status as a quiet button; its popover says why and how to continue. */
function SaveIssuePopover({
  issue,
  actions,
  children,
}: {
  issue: SaveIssue;
  actions: SaveIssueActions;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const wrapped: SaveIssueActions = {
    ...actions,
    undo: actions.undo ? close(actions.undo) : null,
    upgrade: (prompt) => {
      setOpen(false);
      actions.upgrade(prompt);
    },
    retry: close(actions.retry),
    loadLastSaved: close(actions.loadLastSaved),
    removeBroll: (ids) => {
      setOpen(false);
      actions.removeBroll(ids);
    },
    resolveConflict: (choice) => {
      setOpen(false);
      actions.resolveConflict(choice);
    },
    backToProject: close(actions.backToProject),
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(details) => setOpen(details.open)}
      positioning={{ placement: "bottom-end", gutter: 8 }}
    >
      <Popover.Trigger asChild>
        <Flex
          as="button"
          align="center"
          gap="1.5"
          h="32px"
          px="2.5"
          borderRadius="8px"
          bg="studio.raised"
          cursor="pointer"
          aria-haspopup="dialog"
          aria-label="Save needs attention. See details"
          transition="background 120ms ease"
          _hover={{ bg: "studio.borderStrong" }}
        >
          {children}
          <ChevronDown size={12} aria-hidden />
        </Flex>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            w="min(300px, calc(100vw - 24px))"
            p="4"
            bg="studio.surface"
            color="studio.fg"
            borderWidth="0"
            borderRadius="14px"
            boxShadow="none"
          >
            <SaveIssueBody issue={issue} actions={wrapped} />
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

/**
 * Shown in place of the save status while another tab holds the write lease.
 * Sits in the bar rather than over the editor so Export and the tools stay
 * reachable.
 */
function EditingElsewhereNotice({ onTakeOver }: { onTakeOver: () => void }) {
  return (
    <HStack gap="3" ms="3" me="2" role="status" aria-live="polite">
      <HStack gap="1.5" color="studio.fgMuted">
        <Lock size={14} />
        <Text fontSize="13px" whiteSpace="nowrap">
          Editing in another tab
        </Text>
      </HStack>
      <Box
        as="button"
        h="32px"
        px="3"
        borderRadius="8px"
        bg="studio.raised"
        border="none"
        color="studio.fg"
        fontSize="13px"
        fontWeight="500"
        whiteSpace="nowrap"
        cursor="pointer"
        transition="background 120ms ease"
        _hover={{ bg: "studio.borderStrong" }}
        title="Only one tab can edit at a time. Taking over makes the other tab read-only."
        onClick={onTakeOver}
      >
        Take over editing
      </Box>
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
    editingElsewhere,
    handleTakeOverEditing,
    saveIssue,
    saveIssueActions,
  } = useStudio("clipInfo", "canUndo", "canRedo", "showShortcuts", "setShowShortcuts", "handleUndo", "handleRedo", "handleReset", "resetState", "canReset", "saveState", "isDocDirty", "editingElsewhere", "handleTakeOverEditing", "saveIssue", "saveIssueActions");
  const isMac = useIsMac();
  const { openUpgrade } = useUpgrade();
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  return (
    // The header is its own panel, like the transcript, tools and timeline.
    <Flex h="56px" align="center" px="3" gap="2" bg="studio.canvas" borderRadius="12px" flexShrink={0}>
      {/* Left: back + clip title */}
      <HStack gap="1.5" flex="1" minW="0">
        <IconBtn
          icon={<ChevronLeft size={20} />}
          onClick={() => router.push(`/projects/${clipInfo.projectId}`)}
          label="Back to project"
        />
        <Text
          fontSize="18px"
          fontWeight="500"
          letterSpacing="-0.01em"
          color="studio.fg"
          truncate
          maxW="560px"
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
      </HStack>

      {/* Right: history, shortcuts, save state, export */}
      <HStack gap="1" flexShrink={0}>
        <IconBtn
          icon={<Undo2 size={18} />}
          onClick={handleUndo}
          disabled={!canUndo}
          label={isMac ? "Undo (⌘Z)" : "Undo (Ctrl+Z)"}
        />
        <IconBtn
          icon={<Redo2 size={18} />}
          onClick={handleRedo}
          disabled={!canRedo}
          label={isMac ? "Redo (⇧⌘Z)" : "Redo (Ctrl+Shift+Z)"}
        />
        <IconBtn
          icon={<RotateCcw size={17} />}
          onClick={() => setShowResetConfirm(true)}
          disabled={!canReset || resetState === "resetting" || editingElsewhere}
          label="Reset to original"
        />
        <IconBtn
          icon={<Keyboard size={18} />}
          onClick={() => setShowShortcuts(!showShortcuts)}
          label="Keyboard shortcuts"
        />
        {editingElsewhere ? (
          <EditingElsewhereNotice onTakeOver={handleTakeOverEditing} />
        ) : (
          <Box ms="3" me="2">
            <AutosaveIndicator
              saveState={saveState}
              isDocDirty={isDocDirty}
              saveIssue={saveIssue}
              issueActions={{
                ...saveIssueActions,
                undo: canUndo ? handleUndo : null,
                upgrade: openUpgrade,
                openSignIn: () => window.open(authEntryHref("sign-in", "/home"), "_blank", "noopener"),
                backToProject: () => router.push(`/projects/${clipInfo.projectId}`),
              }}
            />
          </Box>
        )}
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
