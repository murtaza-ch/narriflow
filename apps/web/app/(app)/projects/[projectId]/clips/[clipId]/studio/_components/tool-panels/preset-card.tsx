"use client";

import { Box, Flex, Text } from "@chakra-ui/react";
import { CAPTION_MOTIONS, type NamedCaptionPreset } from "@narriflow/validators";
import { CaptionPresetPreview } from "../../../../../../../_shared/caption-preset-preview";
import { SelectedCheck, tileProps } from "./panel-ui";

/** Presets new in the catalog, flagged on their card. */
const NEW_PRESET_IDS = new Set(["jelly", "candy", "neon", "glitch", "flip", "typewriter", "block"]);

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
          aspectRatio="4 / 3"
          captionTopPct={58}
          boost={1.55}
          imageSizes="150px"
        />
        <SelectedCheck show={isSelected} />
      </Box>
      <Flex align="center" justify="space-between" gap="2" px="4px" pt="8px" pb="2px">
        <Box minW="0">
          <Text fontSize="13px" fontWeight="500" color={isSelected ? "studio.accentFg" : "studio.fg"} truncate>
            {namedPreset.name}
          </Text>
          <Text fontSize="11.5px" color={isSelected ? "studio.accentFg" : "studio.fgSubtle"} opacity={isSelected ? 0.75 : 1} mt="1px">
            {CAPTION_MOTIONS[namedPreset.preset.animation].label}
          </Text>
        </Box>
        {NEW_PRESET_IDS.has(namedPreset.id) && (
          <Text as="span" fontSize="9px" fontWeight="600" letterSpacing="0.04em" color="studio.accentFg" textTransform="uppercase" flexShrink={0}>
            New
          </Text>
        )}
      </Flex>
    </Box>
  );
}
