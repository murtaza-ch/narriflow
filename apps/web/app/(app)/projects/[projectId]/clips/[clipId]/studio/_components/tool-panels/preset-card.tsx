"use client";

import { Box, Flex, Text } from "@chakra-ui/react";
import { Check } from "lucide-react";
import { CAPTION_MOTIONS, type NamedCaptionPreset } from "@narriflow/validators";
import { CaptionPresetPreview } from "../../../../../../../_shared/caption-preset-preview";

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
      cursor="pointer"
      w="100%"
      minW={0}
      aria-label={`${namedPreset.name} caption preset`}
      aria-pressed={isSelected}
      textAlign="left"
      borderRadius="l3"
      _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "4px" }}
    >
      <Box
        position="relative"
        borderRadius="10px"
        overflow="hidden"
        transition="box-shadow 140ms ease"
        boxShadow={isSelected ? "0 0 0 2px var(--chakra-colors-studio-accent)" : undefined}
        _hover={isSelected ? {} : { boxShadow: "0 0 0 2px var(--chakra-colors-studio-border-strong)" }}
      >
        <CaptionPresetPreview
          namedPreset={namedPreset}
          aspectRatio="4 / 3"
          captionTopPct={58}
          boost={1.55}
          imageSizes="150px"
        />
        {isSelected && (
          <Flex
            position="absolute"
            top="6px"
            right="6px"
            w="18px"
            h="18px"
            borderRadius="full"
            bg="studio.accent"
            color="studio.canvas"
            align="center"
            justify="center"
          >
            <Check size={11} strokeWidth={3} />
          </Flex>
        )}
      </Box>
      <Box mt="8px" px="2px">
        <Text fontSize="13px" color={isSelected ? "studio.fg" : "studio.fgMuted"} fontWeight="500">
          {namedPreset.name}
        </Text>
        <Flex align="center" justify="space-between" gap="5px" mt="2px">
          <Text fontSize="11px" color="studio.fgSubtle">
            {CAPTION_MOTIONS[namedPreset.preset.animation].label}
          </Text>
          {NEW_PRESET_IDS.has(namedPreset.id) && (
            <Text as="span" fontSize="9px" fontWeight="600" letterSpacing="0.04em" color="studio.accentFg" textTransform="uppercase" flexShrink={0}>
              New
            </Text>
          )}
        </Flex>
      </Box>
    </Box>
  );
}
