"use client";

import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";

export function StudioWriteLeaseOverlay({
  visible,
  onTakeOver,
}: {
  visible: boolean;
  onTakeOver: () => void;
}) {
  if (!visible) return null;

  return (
    <Flex
      position="absolute"
      inset="0"
      zIndex={250}
      align="flex-start"
      justify="flex-end"
      pointerEvents="none"
      p="4"
      role="status"
      aria-live="polite"
    >
      <Box
        layerStyle="panel"
        bg="studio.surface"
        borderWidth="1px"
        borderColor="studio.borderStrong"
        borderRadius="l3"
        p="5"
        maxW="380px"
        w="full"
        pointerEvents="auto"
      >
        <Stack gap="4">
          <Stack gap="2">
            <Text textStyle="eyebrow" color="studio.fgMuted">
              Read-only safety mode
            </Text>
            <Text
              fontFamily="display"
              fontSize="16px"
              fontWeight="600"
              color="studio.fg"
            >
              This clip is being edited in another tab
            </Text>
            <Text fontSize="13px" color="studio.fgMuted" lineHeight="1.6">
              Only one tab can write at a time. Taking over makes this tab the
              editor and puts the other tab into read-only mode, preventing
              conflicting saves and duplicate work.
            </Text>
          </Stack>
          <Flex justify="flex-end">
            <Button
              size="sm"
              colorPalette="brand"
              variant="solid"
              onClick={onTakeOver}
            >
              Take over editing
            </Button>
          </Flex>
        </Stack>
      </Box>
    </Flex>
  );
}
