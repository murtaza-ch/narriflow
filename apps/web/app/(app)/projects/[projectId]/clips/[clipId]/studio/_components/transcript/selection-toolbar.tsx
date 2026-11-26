"use client";

import { Flex } from "@chakra-ui/react";
import { Copy, PanelsTopLeft, Scissors, Trash2, Undo2 } from "lucide-react";
import type { UpgradePrompt } from "@/app/(app)/_components/upgrade";
import { StudioLockGem } from "../studio-lock-gem";

// ─── Selection toolbar (Vizard-parity Phase B step 11) ─────────────────────

function ToolbarBtn({
  icon,
  label,
  iconOnly = false,
  trailing = null,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  /** Universal actions (delete, copy) show the icon alone, named by tooltip. */
  iconOnly?: boolean;
  trailing?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Flex
      as="button"
      align="center"
      justify="center"
      gap="6px"
      minW="32px"
      px={iconOnly ? "0" : "10px"}
      h="32px"
      borderRadius="8px"
      bg="transparent"
      border="none"
      color="studio.fg"
      cursor="pointer"
      fontSize="13px"
      fontWeight="500"
      whiteSpace="nowrap"
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
      // Pressing a toolbar button would otherwise collapse the text
      // selection (the browser's default mousedown-outside-selection
      // behavior) BEFORE the click handler ever runs, wiping the very
      // selection the button is meant to act on.
      onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
      onClick={onClick}
      _hover={{ bg: "studio.borderStrong" }}
      transition="background 120ms ease"
    >
      {icon}
      {iconOnly ? null : label}
      {trailing}
    </Flex>
  );
}

export function SelectionToolbar({
  top,
  left,
  isDeletedSelection,
  creatingClip,
  onDelete,
  onRevert,
  onCopy,
  onCreateClip,
  onInsertScene,
  canInsertScene,
  insertSceneLock = null,
  onUpgrade,
}: {
  top: number;
  left: number;
  isDeletedSelection: boolean;
  creatingClip: boolean;
  onDelete: () => void;
  onRevert: () => void;
  onCopy: () => void;
  onCreateClip: () => void;
  onInsertScene: () => void;
  canInsertScene: boolean;
  /** Shown with a gem instead of hidden when the plan locks scenes. */
  insertSceneLock?: UpgradePrompt | null;
  onUpgrade?: (prompt: UpgradePrompt) => void;
}) {
  return (
    <Flex
      bg="studio.raised"
      borderRadius="10px"
      position="absolute"
      style={{
        top: `${top}px`,
        left: `${left}px`,
        transform: "translate(-50%, calc(-100% - 8px))",
      }}
      align="center"
      gap="2px"
      p="4px"
      zIndex={20}
      onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
    >
      {isDeletedSelection ? (
        <ToolbarBtn icon={<Undo2 size={15} />} label="Revert" onClick={onRevert} />
      ) : (
        <>
          <ToolbarBtn icon={<Trash2 size={16} />} label="Delete" iconOnly onClick={onDelete} />
          <ToolbarBtn icon={<Copy size={15} />} label="Copy" iconOnly onClick={onCopy} />
          {canInsertScene ? (
            <ToolbarBtn icon={<PanelsTopLeft size={15} />} label="Insert scene" onClick={onInsertScene} />
          ) : insertSceneLock?.tier && onUpgrade ? (
            <ToolbarBtn
              icon={<PanelsTopLeft size={15} />}
              label="Insert scene"
              trailing={<StudioLockGem tier={insertSceneLock.tier} />}
              onClick={() => onUpgrade(insertSceneLock)}
            />
          ) : null}
          <ToolbarBtn
            icon={<Scissors size={15} />}
            label={creatingClip ? "Creating…" : "Create clip"}
            onClick={onCreateClip}
          />
        </>
      )}
    </Flex>
  );
}
