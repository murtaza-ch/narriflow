"use client";

import { Menu, Portal } from "@chakra-ui/react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";

export interface Choice {
  value: string;
  label: string;
}

/** One value out of a few, picked from the kit's menu: a quiet trigger that names the current choice. */
export function ChoiceMenu({
  label,
  value,
  options,
  onChange,
  variant = "ghost",
  mono,
}: {
  /** Accessible name, e.g. "Language". */
  label: string;
  value: string;
  options: Choice[];
  onChange: (value: string) => void;
  variant?: "ghost" | "subtle";
  mono?: boolean;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <Menu.Root positioning={{ placement: "bottom-start" }} onSelect={(details) => onChange(details.value)}>
      <Menu.Trigger asChild>
        <Button type="button" variant={variant} size="xs" aria-label={`${label}: ${current.label}`} fontFamily={mono ? "mono" : undefined} color="fg" gap="1">
          {current.label}
          <ChevronDown size={12} />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content aria-label={label} minW="40" maxH="72" overflowY="auto">
            {options.map((option) => (
              <Menu.Item key={option.value} value={option.value} display="flex" alignItems="center" fontFamily={mono ? "mono" : undefined}>
                <Menu.ItemText flex="1">{option.label}</Menu.ItemText>
                {option.value === current.value ? <Check size={14} aria-hidden="true" color="var(--chakra-colors-accent-fg)" /> : null}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
