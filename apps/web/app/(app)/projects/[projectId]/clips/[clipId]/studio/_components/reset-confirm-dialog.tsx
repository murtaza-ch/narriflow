"use client";

import { Dialog, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";

/**
 * Confirmation for Reset-to-original (vizard-parity.md Phase A step 4) — a
 * destructive, unrecoverable-once-confirmed action (it discards every studio
 * edit, including anything not yet autosaved), so it gets an explicit
 * confirm step rather than firing straight off the top-bar icon button.
 * Styled as a true Blueline elevated surface (Chakra Dialog, studio.* tokens
 * only) matching keyboard-shortcuts-modal.tsx.
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
        <Dialog.Backdrop bg="rgba(0,0,0,0.7)" zIndex={300} />
        <Dialog.Positioner zIndex={310}>
          <Dialog.Content
            bg="studio.surface"
            borderWidth="1px"
            borderColor="studio.borderStrong"
            borderRadius="l3"
            w="min(420px, 90vw)"
            maxW="min(420px, 90vw)"
            boxShadow="0 24px 60px rgba(0,0,0,0.7)"
            color="studio.fg"
            p="6"
          >
            <Stack gap="4">
              <Dialog.Title asChild>
                <Text fontFamily="display" fontSize="15px" fontWeight="600" color="studio.fg">
                  Reset this clip to its original version?
                </Text>
              </Dialog.Title>
              <Text fontSize="13px" color="studio.fgMuted" lineHeight="1.5">
                All edits — captions, transcript changes, B-roll, transitions,
                text overlays, and music — will be lost. This can't be undone.
              </Text>
              <Flex justify="flex-end" gap="2" pt="2">
                <Dialog.CloseTrigger asChild>
                  <Button size="sm" variant="ghost" disabled={confirming}>
                    Cancel
                  </Button>
                </Dialog.CloseTrigger>
                <Button
                  size="sm"
                  colorPalette="danger"
                  variant="outline"
                  onClick={onConfirm}
                  loading={confirming}
                  loadingText="Resetting…"
                >
                  Reset clip
                </Button>
              </Flex>
            </Stack>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
