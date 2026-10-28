"use client";

import type { ReactNode } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Check } from "lucide-react";

/**
 * Shared building blocks for the Studio tool panels — one look across every
 * panel: underlined sub-tabs, quiet section labels, segmented switches,
 * borderless tiles and chips, and solid full-width actions. Nothing carries an
 * outline: a chosen chip or tile takes the accent's tint (with a check on
 * tiles), a segmented switch raises its current option, and the active tab
 * and slider fills use the accent, per the color roles in
 * packages/ui/src/theme.ts. Studio tokens only: the editor stays graphite in
 * both color modes.
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

/**
 * Borderless option tile (a layout, a transition, a preset). The chosen tile
 * takes the accent's tint; put a <SelectedCheck /> inside it so the choice
 * reads at a glance on visual tiles too.
 */
export function tileProps(selected: boolean) {
  return {
    position: "relative",
    bg: selected ? "studio.accentSubtle" : "studio.subtle",
    color: selected ? "studio.accentFg" : "studio.fgMuted",
    borderRadius: "12px",
    borderWidth: "0",
    cursor: "pointer",
    transition: "background 120ms ease, color 120ms ease",
    _hover: { bg: selected ? "studio.accentSubtle" : "studio.surface", color: selected ? "studio.accentFg" : "studio.fg" },
  } as const;
}

/** The chosen tile's mark: a small accent check in its top corner. */
export function SelectedCheck({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return (
    <Flex
      position="absolute"
      top="2"
      insetEnd="2"
      boxSize="18px"
      align="center"
      justify="center"
      borderRadius="full"
      bg="studio.accent"
      color="white"
      zIndex="1"
      pointerEvents="none"
      aria-hidden
    >
      <Check size={11} strokeWidth={3} />
    </Flex>
  );
}

/** Small option chip (a font, an animation, a toggle); the chosen one takes the accent's tint. */
export function chipProps(selected: boolean) {
  return {
    h: "32px",
    px: "12px",
    borderRadius: "8px",
    borderWidth: "0",
    bg: selected ? "studio.accentSubtle" : "studio.subtle",
    color: selected ? "studio.accentFg" : "studio.fgMuted",
    fontSize: "13px",
    fontWeight: "500",
    transition: "background 120ms ease, color 120ms ease",
    _hover: selected ? { bg: "studio.accentSubtle", color: "studio.accentFg" } : { bg: "studio.surface", color: "studio.fg" },
  } as const;
}

/**
 * A segmented switch for one-of-a-few choices (insert point, library filter,
 * ratio, style): a soft track whose current option is raised, as the app's
 * segmented controls are. Use chips instead when the options wrap.
 */
export function PanelSegmented<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  size = "md",
}: {
  items: readonly { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
}) {
  return (
    <Flex role="group" aria-label={ariaLabel} gap="2px" p="3px" bg="studio.subtle" borderRadius="10px">
      {items.map((item) => {
        const active = item.value === value;
        return (
          <Flex
            key={item.value}
            as="button"
            aria-pressed={active}
            title={item.title}
            flex="1"
            minW="0"
            h={size === "sm" ? "28px" : "32px"}
            px="2"
            align="center"
            justify="center"
            gap="1.5"
            borderRadius="8px"
            border="none"
            bg={active ? "studio.raised" : "transparent"}
            color={active ? "studio.fg" : "studio.fgMuted"}
            fontSize={size === "sm" ? "12px" : "13px"}
            fontWeight="500"
            whiteSpace="nowrap"
            cursor={item.disabled ? "not-allowed" : "pointer"}
            opacity={item.disabled ? 0.45 : 1}
            transition="background 120ms ease, color 120ms ease"
            _hover={item.disabled || active ? undefined : { color: "studio.fg" }}
            onClick={item.disabled ? undefined : () => onChange(item.value)}
            aria-disabled={item.disabled}
          >
            {item.label}
          </Flex>
        );
      })}
    </Flex>
  );
}

/** A panel's empty state: an icon in a soft circle, one line, an optional hint and actions. */
export function PanelEmpty({
  icon,
  title,
  children,
  actions,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Flex direction="column" align="center" textAlign="center" gap="1.5" px="4" py="7" bg="studio.subtle" borderRadius="12px">
      <Flex boxSize="10" mb="1.5" align="center" justify="center" borderRadius="full" bg="studio.raised" color="studio.fgMuted" aria-hidden>
        {icon}
      </Flex>
      <Text fontSize="14px" fontWeight="500" color="studio.fg">
        {title}
      </Text>
      {children ? (
        <Text fontSize="12.5px" color="studio.fgMuted" lineHeight="1.5" maxW="260px">
          {children}
        </Text>
      ) : null}
      {actions ? (
        <Flex gap="2" mt="2.5" wrap="wrap" justify="center">
          {actions}
        </Flex>
      ) : null}
    </Flex>
  );
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
