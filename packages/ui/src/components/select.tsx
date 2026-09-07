"use client"

import {
  Select as ChakraSelect,
  Portal,
  createListCollection,
} from "@chakra-ui/react"
import * as React from "react"

export interface SelectOption {
  label: string
  value: string
  disabled?: boolean
}

type SelectSize = "sm" | "md"

const triggerHeights: Record<SelectSize, string> = {
  sm: "8",
  md: "9",
}

export interface SelectProps
  extends Omit<
    ChakraSelect.RootProps<SelectOption>,
    | "collection"
    | "value"
    | "defaultValue"
    | "onValueChange"
    | "size"
    | "multiple"
  > {
  items: SelectOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  label?: string
  ariaLabel?: string
  size?: SelectSize
}

/**
 * Blueline single-value Select on Chakra v3 Select (list collection).
 * Trigger is a bordered bg.panel control; the dropdown is a true card.
 */
export const Select = React.forwardRef<HTMLDivElement, SelectProps>(
  function Select(props, ref) {
    const {
      items,
      value,
      defaultValue,
      onValueChange,
      placeholder = "Select…",
      label,
      ariaLabel,
      size = "md",
      ...rest
    } = props

    const collection = React.useMemo(
      () =>
        createListCollection({
          items,
          itemToString: (item) => item.label,
          itemToValue: (item) => item.value,
          isItemDisabled: (item) => Boolean(item.disabled),
        }),
      [items],
    )

    return (
      <ChakraSelect.Root
        ref={ref}
        collection={collection}
        value={value === undefined ? undefined : value ? [value] : []}
        defaultValue={
          defaultValue === undefined ? undefined : [defaultValue]
        }
        onValueChange={(details) => onValueChange?.(details.value[0] ?? "")}
        positioning={{ sameWidth: true }}
        {...rest}
      >
        <ChakraSelect.HiddenSelect />
        {label ? (
          <ChakraSelect.Label
            fontSize="13px"
            fontWeight="500"
            color="fg"
            mb="1.5"
          >
            {label}
          </ChakraSelect.Label>
        ) : null}
        <ChakraSelect.Control>
          <ChakraSelect.Trigger
            aria-label={ariaLabel}
            h={triggerHeights[size]}
            px="2.5"
            bg="bg.panel"
            borderWidth="1px"
            borderColor="border.control"
            borderRadius="l2"
            fontSize="13.5px"
            color="fg"
            cursor="pointer"
            transition="border-color 120ms ease, background 120ms ease"
            _hover={{ borderColor: "border.emphasized" }}
            _disabled={{ cursor: "not-allowed", color: "fg.disabled" }}
          >
            <ChakraSelect.ValueText
              placeholder={placeholder}
              _placeholderShown={{ color: "fg.subtle" }}
            />
            <ChakraSelect.IndicatorGroup>
              <ChakraSelect.Indicator color="fg.muted" />
            </ChakraSelect.IndicatorGroup>
          </ChakraSelect.Trigger>
        </ChakraSelect.Control>
        <Portal>
          <ChakraSelect.Positioner>
            <ChakraSelect.Content
              bg="bg.panel"
              borderWidth="1px"
              borderColor="border"
              borderRadius="l3"
              boxShadow="card"
              p="1"
            >
              {items.map((item) => (
                <ChakraSelect.Item
                  key={item.value}
                  item={item}
                  fontSize="13.5px"
                  px="2"
                  py="1.5"
                  borderRadius="l1"
                  cursor="pointer"
                  color="fg"
                  _highlighted={{ bg: "bg.subtle" }}
                  _disabled={{ color: "fg.disabled", cursor: "not-allowed" }}
                >
                  <ChakraSelect.ItemText>{item.label}</ChakraSelect.ItemText>
                  <ChakraSelect.ItemIndicator color="accent.fg" />
                </ChakraSelect.Item>
              ))}
            </ChakraSelect.Content>
          </ChakraSelect.Positioner>
        </Portal>
      </ChakraSelect.Root>
    )
  },
)
