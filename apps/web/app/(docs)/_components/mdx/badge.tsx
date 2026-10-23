import type { ReactNode } from "react";
import { Badge as KitBadge } from "@narriflow/ui/components/badge";
import { Icon } from "./icon";

// Mintlify's colours on the product's palette: the accent for blue and green
// (there is no green), the neutral soft fill for grey.
const PALETTES = {
  gray: undefined,
  blue: "accent",
  green: "accent",
  yellow: "warning",
  orange: "orange",
  red: "danger",
  purple: "purple",
  white: undefined,
  surface: undefined,
  "white-destructive": "danger",
  "surface-destructive": "danger",
} as const;

export interface BadgeProps {
  color?: keyof typeof PALETTES;
  size?: "xs" | "sm" | "md" | "lg";
  shape?: "rounded" | "pill";
  disabled?: boolean;
  icon?: string;
  children?: ReactNode;
}

export function Badge({ color = "gray", size = "md", shape = "rounded", disabled, icon, children }: BadgeProps) {
  const palette = PALETTES[color];
  return (
    <KitBadge
      size={size}
      variant="subtle"
      gap="1"
      verticalAlign="middle"
      {...(palette ? { colorPalette: palette } : { bg: "bg.soft", color: "fg.muted" })}
      {...(shape === "pill" ? { borderRadius: "full" } : null)}
      {...(disabled ? { opacity: 0.5, cursor: "not-allowed" } : null)}
    >
      <Icon icon={icon} size={12} />
      {children}
    </KitBadge>
  );
}
