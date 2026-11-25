"use client";

import { Box, Text } from "@chakra-ui/react";
import type { NamedCaptionPreset } from "@narriflow/validators";
import { CaptionPresetPreview } from "../../../../../../../_shared/caption-preset-preview";
import { SelectedCheck, tileProps } from "./panel-ui";

export function PresetCard({
  namedPreset,
  isSelected,
  onClick,
}: {
  namedPreset: NamedCaptionPreset;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      as="button"
      onClick={onClick}
      w="100%"
      minW={0}
      p="6px"
      aria-label={`${namedPreset.name} caption preset`}
      aria-pressed={isSelected}
      textAlign="left"
      {...tileProps(isSelected)}
      _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "2px" }}
    >
      <Box position="relative" borderRadius="8px" overflow="hidden">
        <CaptionPresetPreview
          namedPreset={namedPreset}
          aspectRatio="4 / 5"
          backdropFocusYPct={10}
          captionTopPct={66}
          boost={1.55}
          imageSizes="150px"
        />
        <SelectedCheck show={isSelected} />
      </Box>
      <Text fontSize="13px" fontWeight="500" color={isSelected ? "studio.accentFg" : "studio.fg"} truncate px="4px" pt="8px" pb="2px">
        {namedPreset.name}
      </Text>
    </Box>
  );
}
