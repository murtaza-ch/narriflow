"use client";

import { memo } from "react";
import { Box, Text } from "@chakra-ui/react";
import type { NamedCaptionPreset } from "@narriflow/validators";
import { CaptionPresetPreview } from "../../../../../../../_shared/caption-preset-preview";
import { CaptionCardClip, preloadCaptionCardFaces } from "../../../../../../../_shared/caption-card-clip";
import { PRESET_CARD_FRAME, presetHasCardClip } from "../../../../../../../_shared/caption-card-clips";
import { SelectedCheck, tileProps } from "./panel-ui";

/**
 * One caption preset in the gallery. Dynamic and Scene Styles play their pre-rendered clip (the live painters, recorded);
 * classic styles draw their sample live. Memoised: the grid re-renders on each caption edit, a card only when it is
 * (de)selected.
 */
export const PresetCard = memo(function PresetCard({
  namedPreset,
  isSelected,
  onSelect,
}: {
  namedPreset: NamedCaptionPreset;
  isSelected: boolean;
  onSelect: (presetId: string) => void;
}) {
  const clip = presetHasCardClip(namedPreset.preset);
  return (
    <Box
      as="button"
      onClick={() => onSelect(namedPreset.id)}
      onPointerEnter={clip ? () => preloadCaptionCardFaces(namedPreset.id) : undefined}
      w="100%"
      minW={0}
      p="6px"
      aria-label={`${namedPreset.name} caption preset`}
      aria-pressed={isSelected}
      textAlign="left"
      {...tileProps(isSelected)}
      _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "2px" }}
    >
      <Box position="relative" borderRadius="8px" overflow="hidden" bg="studio.canvas">
        {clip ? (
          <CaptionCardClip presetId={namedPreset.id} />
        ) : (
          <CaptionPresetPreview
            namedPreset={namedPreset}
            aspectRatio={PRESET_CARD_FRAME.aspectRatio}
            backdropFocusYPct={PRESET_CARD_FRAME.backdropFocusYPct}
            captionTopPct={PRESET_CARD_FRAME.captionTopPct}
            boost={PRESET_CARD_FRAME.boost}
            imageSizes="150px"
          />
        )}
        <SelectedCheck show={isSelected} />
      </Box>
      <Text fontSize="13px" fontWeight="500" color={isSelected ? "studio.accentFg" : "studio.fg"} truncate px="4px" pt="8px" pb="2px">
        {namedPreset.name}
      </Text>
    </Box>
  );
});
