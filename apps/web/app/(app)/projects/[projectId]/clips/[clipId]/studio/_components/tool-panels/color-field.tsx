"use client";

import { Box, ColorPicker, HStack, Portal, Text, parseColor } from "@chakra-ui/react";

/**
 * A caption colour. The swatch is the user's literal colour; `compact` is the
 * small trigger that sits beside an effect, the default is a labelled tile.
 */
export function ColorField({
  label,
  value,
  onChange,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  compact?: boolean;
}) {
  return (
    <Box minW="0">
      <ColorPicker.Root
        value={parseColor(value)}
        onValueChange={(e) => onChange(e.value.toString("hex"))}
        size="xs"
      >
        <ColorPicker.HiddenInput />
        <ColorPicker.Control>
          <ColorPicker.Trigger
            w={compact ? "28px" : "100%"}
            h={compact ? "28px" : "40px"}
            borderRadius={compact ? "8px" : "10px"}
            borderWidth="0"
            bg={compact ? "studio.raised" : "studio.subtle"}
            cursor="pointer"
            p={compact ? "4px" : "5px"}
            aria-label={`${label} color`}
          >
            <ColorPicker.ValueSwatch w="100%" h="100%" borderRadius={compact ? "5px" : "6px"} />
          </ColorPicker.Trigger>
        </ColorPicker.Control>
        <Portal>
          <ColorPicker.Positioner>
            {/* Portaled — style with mode-invariant studio tokens only */}
            <ColorPicker.Content bg="studio.raised" borderWidth="0" borderRadius="12px" boxShadow="none">
              <ColorPicker.Area />
              <HStack>
                <ColorPicker.EyeDropper size="xs" variant="ghost" bg="studio.subtle" color="studio.fg" />
                <ColorPicker.Sliders />
              </HStack>
            </ColorPicker.Content>
          </ColorPicker.Positioner>
        </Portal>
      </ColorPicker.Root>
      {compact ? null : (
        <Text fontSize="12px" color="studio.fgMuted" mt="6px">
          {label}
        </Text>
      )}
    </Box>
  );
}
