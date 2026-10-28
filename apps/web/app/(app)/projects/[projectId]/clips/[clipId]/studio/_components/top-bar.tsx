"use client";

import { useState } from "react";
import { Box, Flex, Grid, Popover, Portal, Text } from "@chakra-ui/react";
import {
  Check,
  ChevronLeft,
  ChevronDown,
  Cloud,
  CloudOff,
  CircleAlert,
  HardDrive,
  Keyboard,
  Lock,
  Redo2,
  RotateCcw,
  Undo2,
} from "lucide-react";
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

/**
 * Soft icon button for the bar. Same rhythm as the timeline's control groups:
 * 32px, 8px radius, a raised fill on hover, no outline.
 */
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
      boxSize="32px"
      flexShrink={0}
      borderRadius="8px"
      bg="transparent"
      border="none"
      color="studio.fgMuted"
      cursor={disabled ? "not-allowed" : "pointer"}
      opacity={disabled ? 0.38 : 1}
      title={label}
      aria-label={label}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : undefined}
      onClick={disabled ? undefined : onClick}
      transition="background 120ms ease, color 120ms ease"
      _hover={disabled ? undefined : { bg: "studio.raised", color: "studio.fg" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "1px" }}
    >
      {icon}
    </Flex>
  );
}

/** A soft group of related controls (history), like the timeline's control groups. */
function BarGroup({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <Flex role="group" aria-label={label} align="center" gap="1px" p="2px" bg="studio.subtle" borderRadius="10px">
      {children}
    </Flex>
  );
}

type SaveTone = "muted" | "accent" | "danger";

const TONE_ICON: Record<SaveTone, string> = {
  muted: "studio.fgSubtle",
  accent: "studio.accent",
  danger: "studio.danger",
};

/** One save status: an icon, a few words, and a tone. Failure is the only red. */
function SaveStatus({ icon, label, tone = "muted" }: { icon: React.ReactNode; label: string; tone?: SaveTone }) {
  return (
    <Flex align="center" gap="1.5" aria-live="polite">
      <Flex boxSize="14px" align="center" justify="center" color={TONE_ICON[tone]} aria-hidden>
        {icon}
      </Flex>
      <Text fontSize="12.5px" fontWeight="500" color={tone === "danger" ? "studio.danger" : "studio.fgMuted"} whiteSpace="nowrap">
        {label}
      </Text>
    </Flex>
  );
}

/**
 * Ambient autosave indicator: an icon plus micro-copy. Failures additionally
 * surface as an error toast from the shell. 'blocked' is a distinct,
 * non-retryable state (a 409/422 that only clears on reload) — it gets its own
 * copy rather than falling back to the generic "Save failed" so the user knows
 * retrying won't help.
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
    return <SaveStatus icon={<Spinner size="xs" />} label="Saving…" />;
  }

  // Live-QA finding 2026-08-06: 'idle' alone is NOT proof the document is
  // saved — a failed save times back to idle after 4s with the retry still
  // pending, and the debounce window before the first PUT is also 'idle'.
  // Claiming "Saved" while dirty is a silent-data-loss message; consult the
  // dirty flag and say so honestly instead.
  const isBlocked = saveState === "blocked";
  const isError = saveState === "error" || isBlocked;
  const idleButDirty = !isError && isDocDirty;
  const status = isBlocked ? (
    <SaveStatus icon={<CircleAlert size={14} />} label="Save needs attention" tone="danger" />
  ) : saveState === "degraded" ? (
    <SaveStatus icon={<Cloud size={14} />} label="Cloud safety only" tone="accent" />
  ) : saveState === "readonly" ? (
    <SaveStatus icon={<Lock size={13} />} label="Read-only tab" />
  ) : saveState === "offline" ? (
    <SaveStatus icon={<CloudOff size={14} />} label="Saved offline" tone="accent" />
  ) : saveState === "local" ? (
    <SaveStatus icon={<HardDrive size={14} />} label="Saved on this device" tone="accent" />
  ) : isError ? (
    <SaveStatus icon={<CircleAlert size={14} />} label="Save failed" tone="danger" />
  ) : idleButDirty ? (
    <SaveStatus icon={<Box boxSize="6px" borderRadius="full" bg="currentColor" />} label="Unsaved changes…" />
  ) : (
    <SaveStatus icon={<Check size={14} strokeWidth={2.5} />} label="Saved" />
  );
  if (!isBlocked || !saveIssue || !issueActions) return <Box px="2">{status}</Box>;
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
          ps="2.5"
          pe="2"
          borderRadius="8px"
          bg={open ? "studio.raised" : "studio.subtle"}
          color="studio.fgMuted"
          cursor="pointer"
          aria-haspopup="dialog"
          aria-label="Save needs attention. See details"
          transition="background 120ms ease"
          _hover={{ bg: "studio.raised" }}
          _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "1px" }}
        >
          {children}
          <ChevronDown size={13} aria-hidden />
        </Flex>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            w="min(320px, calc(100vw - 24px))"
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
    <Flex align="center" h="32px" ps="2.5" pe="1" gap="2.5" bg="studio.subtle" borderRadius="8px" role="status" aria-live="polite">
      <Flex align="center" gap="1.5" color="studio.fgMuted">
        <Lock size={13} aria-hidden />
        <Text fontSize="12.5px" fontWeight="500" whiteSpace="nowrap">
          Editing in another tab
        </Text>
      </Flex>
      <Box
        as="button"
        h="24px"
        px="2.5"
        borderRadius="6px"
        bg="studio.raised"
        border="none"
        color="studio.fg"
        fontSize="12px"
        fontWeight="500"
        whiteSpace="nowrap"
        cursor="pointer"
        transition="background 120ms ease"
        _hover={{ bg: "studio.borderStrong" }}
        title="Only one tab can edit at a time. Taking over makes the other tab read-only."
        onClick={onTakeOver}
      >
        Take over
      </Box>
    </Flex>
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
    // Three balanced zones: the clip, its history, and the save status with
    // the one primary action.
    <Grid
      h="56px"
      templateColumns="minmax(0, 1fr) auto minmax(0, 1fr)"
      alignItems="center"
      columnGap="3"
      px="3"
      bg="studio.canvas"
      borderRadius="12px"
      flexShrink={0}
    >
      <Flex align="center" gap="1.5" minW="0">
        <Flex
          as="button"
          boxSize="32px"
          flexShrink={0}
          align="center"
          justify="center"
          borderRadius="8px"
          bg="studio.subtle"
          border="none"
          color="studio.fgMuted"
          cursor="pointer"
          title="Back to project"
          aria-label="Back to project"
          transition="background 120ms ease, color 120ms ease"
          _hover={{ bg: "studio.raised", color: "studio.fg" }}
          _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "1px" }}
          onClick={() => router.push(`/projects/${clipInfo.projectId}`)}
        >
          <ChevronLeft size={18} />
        </Flex>
        <Text
          ms="1.5"
          fontSize="15px"
          fontWeight="500"
          letterSpacing="-0.01em"
          color="studio.fg"
          truncate
          minW="0"
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
      </Flex>

      <BarGroup label="History">
        <IconBtn
          icon={<Undo2 size={16} />}
          onClick={handleUndo}
          disabled={!canUndo}
          label={isMac ? "Undo (⌘Z)" : "Undo (Ctrl+Z)"}
        />
        <IconBtn
          icon={<Redo2 size={16} />}
          onClick={handleRedo}
          disabled={!canRedo}
          label={isMac ? "Redo (⇧⌘Z)" : "Redo (Ctrl+Shift+Z)"}
        />
        <Box w="1px" h="14px" mx="1" bg="studio.borderStrong" aria-hidden />
        <IconBtn
          icon={<RotateCcw size={15} />}
          onClick={() => setShowResetConfirm(true)}
          disabled={!canReset || resetState === "resetting" || editingElsewhere}
          label="Reset to original"
        />
      </BarGroup>

      <Flex align="center" justify="flex-end" gap="2" minW="0">
        {editingElsewhere ? (
          <EditingElsewhereNotice onTakeOver={handleTakeOverEditing} />
        ) : (
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
        )}
        <IconBtn
          icon={<Keyboard size={17} />}
          onClick={() => setShowShortcuts(!showShortcuts)}
          label="Keyboard shortcuts"
        />
        <StudioExportMenu />
      </Flex>

      <ResetConfirmDialog
        open={showResetConfirm}
        onOpenChange={setShowResetConfirm}
        confirming={resetState === "resetting"}
        onConfirm={() => {
          void handleReset();
        }}
      />
    </Grid>
  );
}
