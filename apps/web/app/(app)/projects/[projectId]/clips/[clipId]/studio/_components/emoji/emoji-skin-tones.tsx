"use client";

import type { KeyboardEvent } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { CAPTION_EMOJI_SKIN_TONES } from "@narriflow/caption-emoji/draw";

// The six skin-tone swatches, shared by the picker and the Emojis section's Skin tone setting. The
// tones come from the data-free draw entry, so the section's chunk does not carry the catalog.

/** Six tone swatches as a radio group (arrow keys move): 0 is the default yellow, 1 to 5 the skin tones. */
export function SkinTones({ tone, onTone, label = "Skin tone" }: { tone: number; onTone: (tone: number) => void; label?: string }) {
  return (
    <Flex role="radiogroup" aria-label={label} gap="1" flexShrink={0}>
      {CAPTION_EMOJI_SKIN_TONES.map((option) => {
        const checked = option.tone === tone;
        return (
          <Box
            key={option.tone}
            as="button"
            role="radio"
            aria-checked={checked}
            aria-label={`Skin tone: ${option.name.replace("-", " ")}`}
            title={option.name === "default" ? "Default skin tone" : `${option.name.replace("-", " ")} skin tone`}
            tabIndex={checked ? 0 : -1}
            boxSize="20px"
            p="3px"
            borderRadius="full"
            bg="transparent"
            boxShadow={checked ? "inset 0 0 0 2px var(--chakra-colors-studio-accent)" : "none"}
            cursor="pointer"
            _hover={checked ? undefined : { bg: "studio.raised" }}
            onClick={() => onTone(option.tone)}
            onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
              const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
              if (step === 0) return;
              event.preventDefault();
              const next = (tone + step + 6) % 6;
              onTone(next);
              (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
            }}
          >
            <Box w="full" h="full" borderRadius="full" style={{ background: option.hex }} />
          </Box>
        );
      })}
    </Flex>
  );
}
