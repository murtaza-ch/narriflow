"use client";

import { useState, type ComponentType } from "react";
import { Box, Flex, Grid, Text } from "@chakra-ui/react";
import { CAPTION_EMOJI_PALETTES, type CaptionEmojiPalette, type CaptionEmojiPosition, type CaptionPreset } from "@narriflow/validators";
import { PanelSegmented, tileProps } from "../tool-panels/panel-ui";
import { SkinTones } from "./emoji-skin-tones";

/** The Captions panel's colour control, passed in so the emoji colours use the same one. */
export type EmojiColourField = ComponentType<{ label: string; value: string; onChange: (hex: string) => void }>;

/** An accessible on/off switch in the panel's switch look. */
export function EmojiSwitch({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <Box
      as="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled}
      position="relative"
      flexShrink={0}
      w="34px"
      h="20px"
      p="0"
      borderRadius="full"
      border="none"
      bg={checked ? "studio.accent" : "studio.raised"}
      cursor={disabled ? "not-allowed" : "pointer"}
      opacity={disabled ? 0.45 : 1}
      transition="background 120ms ease"
      _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "2px" }}
      onClick={disabled ? undefined : () => onChange(!checked)}
    >
      <Box
        position="absolute"
        top="2px"
        left="2px"
        boxSize="16px"
        borderRadius="full"
        bg={checked ? "white" : "studio.fgMuted"}
        transform={checked ? "translateX(14px)" : "none"}
        transition="transform 140ms ease, background 120ms ease"
        css={{ "@media (prefers-reduced-motion: reduce)": { transition: "none" } }}
      />
    </Box>
  );
}

function Swatches({ palette }: { palette: CaptionEmojiPalette }) {
  return (
    <Flex aria-hidden>
      {[palette.a, palette.b, palette.c].map((colour, at) => (
        <Box key={at} boxSize="14px" ms={at === 0 ? "0" : "-4px"} borderRadius="full" style={{ background: colour, boxShadow: "0 0 0 2px var(--chakra-colors-studio-subtle), inset 0 0 0 1px rgba(255, 255, 255, 0.24)" }} />
      ))}
    </Flex>
  );
}

type PaletteChoice = "match" | (typeof CAPTION_EMOJI_PALETTES)[number]["id"] | "custom";

const samePalette = (left: CaptionEmojiPalette, right: CaptionEmojiPalette) =>
  left.a.toLowerCase() === right.a.toLowerCase() && left.b.toLowerCase() === right.b.toLowerCase() && left.c.toLowerCase() === right.c.toLowerCase();

/** Which colour option a stored palette shows as: none is Match template, a named one is its name, anything else Custom. */
export function emojiPaletteChoice(stored: CaptionEmojiPalette | undefined): PaletteChoice {
  if (!stored) return "match";
  return CAPTION_EMOJI_PALETTES.find((option) => samePalette(option.palette, stored))?.id ?? "custom";
}

const SIZES = [
  { value: "0.8", label: "S" },
  { value: "1", label: "M" },
  { value: "1.25", label: "L" },
] as const;

const POSITIONS: readonly { value: CaptionEmojiPosition; label: string; title: string }[] = [
  { value: "auto", label: "Auto", title: "Above the caption, or below it when the caption sits near the top" },
  { value: "above", label: "Above", title: "Above the caption" },
  { value: "below", label: "Below", title: "Below the caption" },
];

function SubLabel({ children }: { children: string }) {
  return (
    <Text fontSize="12px" color="studio.fgMuted" mb="2">
      {children}
    </Text>
  );
}

/**
 * Colours, size, position, skin tone and sticker outline: preset fields, so undo, brand templates
 * and Apply to all carry them. The skin tone is the one every emoji with skin takes unless its
 * tone was picked by hand (`captionEmojiDrawnTone`), so changing it updates the AI's emojis.
 */
export function EmojiStyleControls({
  preset,
  matchPalette,
  update,
  ColourField,
}: {
  preset: CaptionPreset;
  /** The palette derived from the template's colours (what Match template draws). */
  matchPalette: CaptionEmojiPalette;
  update: (patch: Partial<CaptionPreset>) => void;
  ColourField: EmojiColourField;
}) {
  const stored = preset.emojiPalette;
  const [customChosen, setCustomChosen] = useState(false);
  const choice: PaletteChoice = customChosen ? "custom" : emojiPaletteChoice(stored);
  const custom = stored ?? matchPalette;
  const options: { id: PaletteChoice; label: string; palette: CaptionEmojiPalette | null }[] = [
    { id: "match", label: "Template", palette: matchPalette },
    ...CAPTION_EMOJI_PALETTES.map((option) => ({ id: option.id as PaletteChoice, label: option.name, palette: option.palette as CaptionEmojiPalette })),
    { id: "custom", label: "Custom", palette: null },
  ];
  return (
    <Flex direction="column" gap="4">
      <Box>
        <SubLabel>Colors</SubLabel>
        <Grid templateColumns="repeat(3, minmax(0, 1fr))" gap="6px" role="radiogroup" aria-label="Emoji colors">
          {options.map((option) => {
            const selected = option.id === choice;
            return (
              <Flex
                key={option.id}
                as="button"
                role="radio"
                aria-checked={selected}
                aria-label={option.id === "match" ? "Match template colors" : option.id === "custom" ? "Custom colors" : `${option.label} colors`}
                direction="column"
                align="center"
                justify="center"
                gap="5px"
                h="52px"
                {...tileProps(selected)}
                borderRadius="10px"
                onClick={() => {
                  setCustomChosen(option.id === "custom");
                  if (option.id === "match") update({ emojiPalette: undefined });
                  else if (option.id === "custom") update({ emojiPalette: { ...custom } });
                  else update({ emojiPalette: { ...option.palette! } });
                }}
              >
                {option.palette ? <Swatches palette={option.palette} /> : <Swatches palette={custom} />}
                <Text as="span" fontSize="12px" fontWeight="500">
                  {option.label}
                </Text>
              </Flex>
            );
          })}
        </Grid>
        {choice === "custom" ? (
          <Grid templateColumns="repeat(3, minmax(0, 1fr))" gap="10px" mt="3">
            <ColourField label="Body" value={custom.a} onChange={(a) => update({ emojiPalette: { ...custom, a } })} />
            <ColourField label="Accent" value={custom.b} onChange={(b) => update({ emojiPalette: { ...custom, b } })} />
            <ColourField label="Detail" value={custom.c} onChange={(c) => update({ emojiPalette: { ...custom, c } })} />
          </Grid>
        ) : null}
      </Box>
      <Grid templateColumns="minmax(0, 2fr) minmax(0, 3fr)" gap="10px">
        <Box>
          <SubLabel>Size</SubLabel>
          <PanelSegmented ariaLabel="Emoji size" size="sm" value={String(preset.emojiSize ?? 1)} onChange={(value) => update({ emojiSize: value === "1" ? undefined : (Number(value) as 0.8 | 1.25) })} items={SIZES} />
        </Box>
        <Box>
          <SubLabel>Position</SubLabel>
          <PanelSegmented ariaLabel="Emoji position" size="sm" value={preset.emojiPosition ?? "auto"} onChange={(value) => update({ emojiPosition: value === "auto" ? undefined : value })} items={POSITIONS} />
        </Box>
      </Grid>
      <Flex align="center" justify="space-between" gap="3" minH="32px" px="3.5" bg="studio.subtle" borderRadius="12px" py="1.5">
        <Text fontSize="13px" color="studio.fg" title="Emojis added by AI use this tone">
          Skin tone
        </Text>
        <SkinTones tone={preset.emojiTone ?? 0} onTone={(tone) => update({ emojiTone: tone === 0 ? undefined : tone })} />
      </Flex>
      <Flex align="center" justify="space-between" gap="3" minH="32px" px="3.5" bg="studio.subtle" borderRadius="12px" py="1.5">
        <Text fontSize="13px" color="studio.fg">
          Sticker outline
        </Text>
        <EmojiSwitch label="Sticker outline" checked={preset.emojiSticker !== false} onChange={(on) => update({ emojiSticker: on ? undefined : false })} />
      </Flex>
    </Flex>
  );
}
