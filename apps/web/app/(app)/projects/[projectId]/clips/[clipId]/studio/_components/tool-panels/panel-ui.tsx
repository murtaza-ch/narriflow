"use client";

import type { ReactNode } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";

/**
 * Shared building blocks for the Studio tool panels — one look across every
 * panel: underlined sub-tabs, quiet section labels, borderless tiles, and
 * solid full-width actions. Selection, the active tab and slider fills use the
 * accent, per the color roles in packages/ui/src/theme.ts. Studio tokens only:
 * the editor stays graphite in both color modes.
 */

/** Horizontal inset every panel's content shares with the panel title. */
export const PANEL_PX = "5";

export function PanelTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: readonly { id: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}) {
  return (
    <Flex
      role="tablist"
      aria-label={ariaLabel}
      gap="5"
      px={PANEL_PX}
      borderBottomWidth="1px"
      borderColor="studio.border"
      flexShrink={0}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <Flex
            key={item.id}
            as="button"
            role="tab"
            aria-selected={active}
            position="relative"
            align="center"
            gap="1.5"
            h="40px"
            bg="transparent"
            border="none"
            color={active ? "studio.fg" : "studio.fgMuted"}
            fontSize="14px"
            fontWeight="500"
            cursor="pointer"
            transition="color 120ms ease"
            _hover={{ color: "studio.fg" }}
            onClick={() => onChange(item.id)}
          >
            {item.icon}
            {item.label}
            {active ? (
              <Box
                position="absolute"
                left="0"
                right="0"
                bottom="-1px"
                h="2px"
                borderRadius="full"
                bg="studio.accent"
              />
            ) : null}
          </Flex>
        );
      })}
    </Flex>
  );
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <Flex align="center" justify="space-between" gap="3" mb="2.5">
      <Text fontSize="13px" fontWeight="500" color="studio.fgMuted">
        {children}
      </Text>
      {action}
    </Flex>
  );
}

/** Borderless option tile; selection is an accent outline. */
export function tileProps(selected: boolean) {
  return {
    bg: "studio.subtle",
    borderRadius: "10px",
    borderWidth: "2px",
    borderColor: selected ? "studio.accent" : "transparent",
    cursor: "pointer",
    transition: "background 120ms ease, border-color 120ms ease",
    _hover: { bg: "studio.raised" },
  } as const;
}

/** Small option chip (style, ratio, source); selection is an accent outline. */
export function chipProps(selected: boolean) {
  return {
    h: "34px",
    px: "12px",
    borderRadius: "8px",
    bg: selected ? "studio.accentSubtle" : "studio.subtle",
    borderWidth: "2px",
    borderColor: selected ? "studio.accent" : "transparent",
    color: selected ? "studio.fg" : "studio.fgMuted",
    fontSize: "13px",
    fontWeight: "500",
    _hover: { bg: "studio.raised", color: "studio.fg" },
  } as const;
}

/** Secondary in-panel action: soft fill, no border. */
export const softButtonProps = {
  variant: "ghost",
  bg: "studio.raised",
  color: "studio.fg",
  borderRadius: "8px",
  _hover: { bg: "studio.borderStrong" },
} as const;

/**
 * Studio slider: accent fill and a white thumb, like the app's kit Slider.
 * Pass as `css` on Slider.Root.
 */
export const studioSliderCss = {
  "& [data-part=track]": { bg: "studio.raised" },
  "& [data-part=range]": { bg: "studio.accent" },
  "& [data-part=thumb]": { bg: "studio.fg", borderColor: "studio.fg" },
} as const;

/**
 * Soft filled field — search boxes and text inputs inside panels. Focus shows
 * a subtle grey edge, like the app's fields, not the accent ring.
 */
const fieldFocus = { borderColor: "studio.borderFocus", outline: "none", boxShadow: "none" } as const;
export const softFieldProps = {
  bg: "studio.subtle",
  borderWidth: "1px",
  borderColor: "transparent",
  borderRadius: "10px",
  color: "studio.fg",
  focusVisibleRing: "none",
  _placeholder: { color: "studio.fgSubtle" },
  _focus: fieldFocus,
  _focusVisible: fieldFocus,
} as const;

/** `_focusWithin` for a soft row that wraps a bare input (icon + input). */
export const softFocusWithin = {
  boxShadow: "inset 0 0 0 1px var(--chakra-colors-studio-border-focus)",
} as const;

/** Solid full-width panel action, e.g. "Add text" or "Apply to this clip". */
export function PanelButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Flex
      as="button"
      w="full"
      h="44px"
      align="center"
      justify="center"
      gap="2"
      borderRadius="10px"
      bg="studio.raised"
      border="none"
      color="studio.fg"
      fontSize="14px"
      fontWeight="500"
      cursor={disabled ? "not-allowed" : "pointer"}
      opacity={disabled ? 0.45 : 1}
      title={title}
      aria-disabled={disabled}
      transition="background 120ms ease"
      _hover={disabled ? undefined : { bg: "studio.borderStrong" }}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </Flex>
  );
}
