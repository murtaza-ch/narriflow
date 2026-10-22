"use client"

import {
  Combobox as ChakraCombobox,
  Portal,
  useFilter,
  useListCollection,
} from "@chakra-ui/react"
import * as React from "react"
import type { SelectOption } from "./select"

export interface ComboboxProps
  extends Omit<
    ChakraCombobox.RootProps<SelectOption>,
    | "collection"
    | "value"
    | "defaultValue"
    | "onValueChange"
    | "multiple"
  > {
  items: SelectOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  label?: string
  ariaLabel?: string
  emptyText?: string
}

/** Searchable Blueline control built on Chakra's Combobox collection API. */
export const Combobox = React.forwardRef<HTMLDivElement, ComboboxProps>(
  function Combobox(props, ref) {
    const {
      items,
      value,
      defaultValue,
      onValueChange,
      placeholder = "Type to search…",
      label,
      ariaLabel,
      emptyText = "No matches found",
      ...rest
    } = props
    const { contains } = useFilter({ sensitivity: "base" })
    const { collection, filter, set } = useListCollection({
      initialItems: items,
      itemToString: (item) => item.label,
      itemToValue: (item) => item.value,
      isItemDisabled: (item) => Boolean(item.disabled),
      filter: contains,
    })

    React.useEffect(() => set(items), [items, set])

    return (
      <ChakraCombobox.Root
        ref={ref}
        collection={collection}
        value={value === undefined ? undefined : value ? [value] : []}
        defaultValue={
          defaultValue === undefined ? undefined : defaultValue ? [defaultValue] : []
        }
        onValueChange={(details) => onValueChange?.(details.value[0] ?? "")}
        onInputValueChange={(details) => filter(details.inputValue)}
        openOnClick
        positioning={{ sameWidth: true }}
        {...rest}
      >
        {label ? (
          <ChakraCombobox.Label
            fontSize="13px"
            fontWeight="500"
            color="fg"
            mb="1.5"
          >
            {label}
          </ChakraCombobox.Label>
        ) : null}
        <ChakraCombobox.Control>
          <ChakraCombobox.Input
            aria-label={ariaLabel}
            placeholder={placeholder}
            h="10"
            px="3"
            bg="bg.soft"
            borderWidth="1px"
            borderColor="transparent"
            borderRadius="control"
            fontSize="13.5px"
            color="fg"
            focusVisibleRing="none"
            _hover={{ bg: "bg.softHover" }}
            _focus={{ borderColor: "border.focus", outline: "none" }}
            _focusVisible={{ borderColor: "border.focus", outline: "none" }}
          />
          <ChakraCombobox.IndicatorGroup>
            <ChakraCombobox.ClearTrigger color="fg.muted" />
            <ChakraCombobox.Trigger color="fg.muted" />
          </ChakraCombobox.IndicatorGroup>
        </ChakraCombobox.Control>
        <Portal>
          <ChakraCombobox.Positioner>
            <ChakraCombobox.Content
              bg="bg.raised"
              borderWidth="1px"
              borderColor="border.card"
              borderRadius="l2"
              boxShadow="none"
              p="1.5"
            >
              <ChakraCombobox.Empty px="2" py="2" color="fg.muted" fontSize="13px">
                {emptyText}
              </ChakraCombobox.Empty>
              {collection.items.map((item) => (
                <ChakraCombobox.Item
                  key={item.value}
                  item={item}
                  minH="9"
                  px="2.5"
                  borderRadius="8px"
                  fontSize="14px"
                  color="fg"
                  cursor="pointer"
                  _highlighted={{ bg: "bg.soft" }}
                  _disabled={{ color: "fg.disabled", cursor: "not-allowed" }}
                >
                  <ChakraCombobox.ItemText>{item.label}</ChakraCombobox.ItemText>
                  <ChakraCombobox.ItemIndicator color="accent.fg" />
                </ChakraCombobox.Item>
              ))}
            </ChakraCombobox.Content>
          </ChakraCombobox.Positioner>
        </Portal>
      </ChakraCombobox.Root>
    )
  },
)
