"use client";

import { Dialog, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { RotateCcw } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";

const actionProps = {
  h: "40px",
  px: "4",
  borderRadius: "10px",
  fontSize: "14px",
  fontWeight: "500",
} as const;

/**
 * Confirmation for Reset-to-original (vizard-parity.md Phase A step 4) — a
 * destructive, unrecoverable-once-confirmed action (it discards every studio
 * edit, including anything not yet autosaved), so it gets an explicit
 * confirm step rather than firing straight off the top-bar icon button.
 * Studio tokens only (the dialog renders in a portal, outside the always-dark
 * editor): a quiet cancel beside one danger-filled action.
 */
export function ResetConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  confirming,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => onOpenChange(e.open)}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop zIndex={300} />
        <Dialog.Positioner zIndex={310}>
          <Dialog.Content
            w="min(420px, 92vw)"
            maxW="min(420px, 92vw)"
            bg="studio.surface"
            color="studio.fg"
            borderRadius="14px"
            p="6"
          >
            <Flex boxSize="40px" mb="4" align="center" justify="center" borderRadius="full" bg="studio.raised" color="studio.danger" aria-hidden>
              <RotateCcw size={18} />
            </Flex>
            <Stack gap="2">
              <Dialog.Title asChild>
                <Text fontSize="17px" fontWeight="500" letterSpacing="-0.01em" color="studio.fg">
                  Reset this clip to its original version?
                </Text>
              </Dialog.Title>
              <Dialog.Description asChild>
                <Text fontSize="14px" color="studio.fgMuted" lineHeight="1.6">
                  All edits — captions, transcript changes, B-roll, transitions,
                  text overlays, and music — will be lost. This can't be undone.
                </Text>
              </Dialog.Description>
            </Stack>
            <Flex justify="flex-end" gap="2" mt="6">
              {/* ActionTrigger, not CloseTrigger: the dialog recipe pins
                  CloseTrigger to the top-right corner. */}
              <Dialog.ActionTrigger asChild>
                <Button
                  {...actionProps}
                  bg="studio.raised"
                  color="studio.fg"
                  _hover={{ bg: "studio.borderStrong" }}
                  disabled={confirming}
                >
                  Cancel
                </Button>
              </Dialog.ActionTrigger>
              <Button
                {...actionProps}
                bg="studio.danger"
                color="studio.canvas"
                _hover={{ bg: "studio.dangerBorder" }}
                onClick={onConfirm}
                loading={confirming}
                loadingText="Resetting…"
              >
                Reset clip
              </Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
