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
    <Box as="button" onClick={onClick} cursor="pointer" w="100%" aria-pressed={isSelected} textAlign="left">
      <Box
        position="relative"
        borderRadius="l3"
        overflow="hidden"
        transition="box-shadow 140ms ease"
        boxShadow={
          isSelected
            ? "0 0 0 2px var(--chakra-colors-studio-accent), 0 0 0 5px color-mix(in srgb, var(--chakra-colors-studio-accent) 22%, transparent)"
            : "inset 0 0 0 1px var(--chakra-colors-studio-border)"
        }
        _hover={isSelected ? {} : { boxShadow: "0 0 0 1px var(--chakra-colors-studio-border-strong)" }}
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
      <Flex mt="6px" px="2px" align="center" justify="space-between" gap="6px">
        <Flex align="center" gap="5px" minW={0}>
          <Text fontSize="12px" color={isSelected ? "studio.fg" : "studio.fgMuted"} fontWeight="500" truncate>
            {namedPreset.name}
          </Text>
          {NEW_PRESET_IDS.has(namedPreset.id) && (
            <Text as="span" fontSize="9px" fontWeight="600" letterSpacing="0.04em" color="studio.accentFg" textTransform="uppercase">
              New
            </Text>
          )}
        </Flex>
        <Text fontSize="10px" color="studio.fgSubtle" flexShrink={0}>
          {CAPTION_MOTIONS[namedPreset.preset.animation].label}
        </Text>
      </Flex>
    </Box>
  );
}
