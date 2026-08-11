"use client";

import { Dialog, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui";

export function DraftRecoveryDialog({
  open,
  conflictPaths,
  onKeepCloud,
  onRecoverLocal,
}: {
  open: boolean;
  conflictPaths: string[];
  onKeepCloud: () => void;
  onRecoverLocal: () => void;
}) {
  return (
    <Dialog.Root open={open} closeOnEscape={false} closeOnInteractOutside={false} placement="center">
      <Portal>
        <Dialog.Backdrop bg="rgba(0,0,0,0.76)" zIndex={400} />
        <Dialog.Positioner zIndex={410}>
          <Dialog.Content
            bg="studio.surface"
            borderWidth="1px"
            borderColor="studio.borderStrong"
            borderRadius="l3"
            w="min(480px, 92vw)"
            maxW="min(480px, 92vw)"
            boxShadow="0 24px 60px rgba(0,0,0,0.7)"
            color="studio.fg"
            p="6"
          >
            <Stack gap="4">
              <Dialog.Title asChild>
                <Text fontFamily="display" fontSize="16px" fontWeight="600" color="studio.fg">
                  A recovered draft overlaps newer cloud edits
                </Text>
              </Dialog.Title>
              <Dialog.Description asChild>
                <Text fontSize="13px" color="studio.fgMuted" lineHeight="1.6">
                  Narriflow kept the draft on this device, but both copies changed the same
                  {conflictPaths.length === 1 ? " area" : " areas"}. Choose which version should
                  become the editable copy. The recovered draft stays stored until you decide.
                </Text>
              </Dialog.Description>
              <Text textStyle="data" fontSize="11px" color="studio.fgSubtle">
                {conflictPaths.slice(0, 4).join(" · ")}
                {conflictPaths.length > 4 ? ` · +${conflictPaths.length - 4} more` : ""}
              </Text>
              <Flex justify="flex-end" gap="2" pt="2" wrap="wrap">
                <Button size="sm" variant="ghost" onClick={onKeepCloud}>
                  Keep cloud version
                </Button>
                <Button size="sm" colorPalette="accent" variant="solid" onClick={onRecoverLocal}>
                  Recover this device's draft
                </Button>
              </Flex>
            </Stack>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
