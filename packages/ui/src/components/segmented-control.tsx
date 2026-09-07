"use client";

import { SegmentGroup as ChakraSegmentGroup } from "@chakra-ui/react";
import * as React from "react";

export interface SegmentedControlOption {
  label: React.ReactNode;
  value: string;
  disabled?: boolean;
}

type SegmentedControlSize = "sm" | "md";

export interface SegmentedControlProps
  extends Omit<ChakraSegmentGroup.RootProps, "onValueChange" | "size" | "children"> {
  items: Array<string | SegmentedControlOption>;
  /** Simplified change handler — receives the selected value. */
  onValueChange?: (value: string) => void;
  size?: SegmentedControlSize;
}

const normalize = (item: string | SegmentedControlOption): SegmentedControlOption =>
  typeof item === "string" ? { label: item, value: item } : item;

export const SegmentedControl = React.forwardRef<HTMLDivElement, SegmentedControlProps>(
  function SegmentedControl(props, ref) {
    const { items, onValueChange, size = "sm", ...rest } = props;
    const options = items.map(normalize);

    return (
      <ChakraSegmentGroup.Root
        ref={ref}
        size={size}
        onValueChange={(details) => {
          if (details.value != null) onValueChange?.(details.value);
        }}
        {...rest}
      >
        <ChakraSegmentGroup.Indicator />
        {options.map((option) => (
          <ChakraSegmentGroup.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            <ChakraSegmentGroup.ItemText>{option.label}</ChakraSegmentGroup.ItemText>
            <ChakraSegmentGroup.ItemHiddenInput />
          </ChakraSegmentGroup.Item>
        ))}
      </ChakraSegmentGroup.Root>
    );
  },
);
