"use client"

import { SegmentGroup as ChakraSegmentGroup } from "@chakra-ui/react"
import * as React from "react"

export interface SegmentedControlOption {
  label: React.ReactNode
  value: string
  disabled?: boolean
}

type SegmentedControlSize = "sm" | "md"

const itemHeights: Record<SegmentedControlSize, string> = {
  sm: "6",
  md: "7",
}

const fontSizes: Record<SegmentedControlSize, string> = {
  sm: "12.5px",
  md: "13px",
}

export interface SegmentedControlProps
  extends Omit<
    ChakraSegmentGroup.RootProps,
    "onValueChange" | "size" | "children"
  > {
  items: Array<string | SegmentedControlOption>
  /** Simplified change handler — receives the selected value. */
  onValueChange?: (value: string) => void
  size?: SegmentedControlSize
}

const normalize = (
  item: string | SegmentedControlOption,
): SegmentedControlOption =>
  typeof item === "string" ? { label: item, value: item } : item

/**
 * Blueline SegmentedControl on Chakra v3 SegmentGroup.
 * bg.subtle track with a border.control boundary; the selected item is a
 * crisp bg.panel plate with its own 1px border — not a pill.
 */
export const SegmentedControl = React.forwardRef<
  HTMLDivElement,
  SegmentedControlProps
>(function SegmentedControl(props, ref) {
  const { items, onValueChange, size = "md", ...rest } = props
  const options = items.map(normalize)

  return (
    <ChakraSegmentGroup.Root
      ref={ref}
      bg="bg.subtle"
      borderWidth="1px"
      borderColor="border.control"
      borderRadius="l2"
      p="2px"
      onValueChange={(details) => {
        if (details.value != null) onValueChange?.(details.value)
      }}
      {...rest}
    >
      <ChakraSegmentGroup.Indicator
        bg="bg.panel"
        borderWidth="1px"
        borderColor="border"
        borderRadius="l1"
        boxShadow="card"
      />
      {options.map((option) => (
        <ChakraSegmentGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          h={itemHeights[size]}
          px="3"
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          borderRadius="l1"
          cursor="pointer"
          color="fg.muted"
          fontWeight="500"
          fontSize={fontSizes[size]}
          transition="color 120ms ease"
          _hover={{ color: "fg" }}
          _checked={{ color: "fg", fontWeight: "600" }}
          _disabled={{ color: "fg.disabled", cursor: "not-allowed" }}
        >
          <ChakraSegmentGroup.ItemText>
            {option.label}
          </ChakraSegmentGroup.ItemText>
          <ChakraSegmentGroup.ItemHiddenInput />
        </ChakraSegmentGroup.Item>
      ))}
    </ChakraSegmentGroup.Root>
  )
})
