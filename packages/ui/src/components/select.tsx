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
 * Single-value Select on Chakra v3 Select (list collection).
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
      size = "sm",
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
        size={size}
        collection={collection}
        value={value === undefined ? undefined : [value]}
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
              p="1"
            >
              {items.map((item) => (
                <ChakraSelect.Item
                  key={item.value}
                  item={item}
                  px="2"
                  py="1.5"
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
