"use client";

import type { ReactNode } from "react";
import { Tabs } from "@chakra-ui/react";
import { Expandable } from "./expandable";

export interface VariantTabsProps {
  variants: Array<{ label: string; content: ReactNode }>;
}

/** "Option 1 / Option 2" tabs for a oneOf/anyOf, with the active variant's attributes below. */
export function VariantTabs({ variants }: VariantTabsProps) {
  return (
    <Tabs.Root defaultValue="0" variant="line" size="sm" mt="3">
      <Tabs.List>
        {variants.map((variant, index) => (
          <Tabs.Trigger key={variant.label} value={String(index)}>
            {variant.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {variants.map((variant, index) => (
        <Tabs.Content key={variant.label} value={String(index)} px="0" pt="0">
          {variant.content ? <Expandable>{variant.content}</Expandable> : null}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
