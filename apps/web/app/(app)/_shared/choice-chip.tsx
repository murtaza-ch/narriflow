"use client";

import type { ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import { Check, Plus } from "lucide-react";

/**
 * A toggle chip (platforms, tones, suggested moments, presets), in the app's
 * own roles: resting is the soft control fill, picked is the accent's
 * selected state (`accent.subtle`, hovering to `accent.muted`) with a check.
 */
export function ChoiceChip({
  on,
  onToggle,
  icon,
  showMark = true,
  disabled = false,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  /** Leading visual, such as a platform logo; replaces the check/plus mark. */
  icon?: ReactNode;
  showMark?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <chakra.button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onToggle}
      display="inline-flex"
      alignItems="center"
      gap="1.5"
      h={icon ? "9" : "7"}
      ps={icon ? "2" : "2.5"}
      pe={icon ? "3" : "2.5"}
      borderRadius="full"
      bg={on ? "accent.subtle" : "bg.soft"}
      color={on ? "accent.fg" : "fg.muted"}
      fontSize={icon ? "13px" : "12px"}
      cursor={disabled ? "default" : "pointer"}
      transition="background 120ms ease, color 120ms ease"
      _hover={disabled ? undefined : { bg: on ? "accent.muted" : "bg.softHover", color: on ? "accent.fg" : "fg" }}
    >
      {icon ??
        (showMark ? (
          on ? (
            <Check size={12} strokeWidth={2.5} aria-hidden />
          ) : (
            <Plus size={12} aria-hidden />
          )
        ) : null)}
      {children}
    </chakra.button>
  );
}
