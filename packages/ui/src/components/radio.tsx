"use client"

import { RadioGroup as ChakraRadioGroup } from "@chakra-ui/react"
import * as React from "react"

export interface RadioGroupProps
  extends Omit<ChakraRadioGroup.RootProps, "onValueChange"> {
  /** Simplified change handler — receives the selected value. */
  onValueChange?: (value: string) => void
}

/**
 * Blueline RadioGroup on Chakra v3 RadioGroup. Compose with <Radio>.
 */
export const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(
  function RadioGroup(props, ref) {
    const { onValueChange, ...rest } = props
    return (
      <ChakraRadioGroup.Root
        ref={ref}
        onValueChange={(details) => {
          if (details.value != null) onValueChange?.(details.value)
        }}
        {...rest}
      />
    )
  },
)

export interface RadioProps extends ChakraRadioGroup.ItemProps {
  /** Props forwarded to the hidden native input (e.g. name, form). */
  inputProps?: React.ComponentProps<
    typeof ChakraRadioGroup.ItemHiddenInput
  >
}

/**
 * Blueline Radio item — border.control circle, accent.solid dot when checked.
 */
export const Radio = React.forwardRef<HTMLDivElement, RadioProps>(
  function Radio(props, ref) {
    const { children, inputProps, ...rest } = props

    return (
      <ChakraRadioGroup.Item
        ref={ref}
        gap="2"
        cursor="pointer"
        _disabled={{ cursor: "not-allowed" }}
        {...rest}
      >
        <ChakraRadioGroup.ItemHiddenInput {...inputProps} />
        <ChakraRadioGroup.ItemControl
          boxSize="4"
          borderRadius="full"
          borderWidth="1px"
          borderColor="border.control"
          bg="bg.panel"
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          transition="border-color 120ms ease"
          _checked={{ borderColor: "accent.solid" }}
          _disabled={{ borderColor: "border", bg: "bg.muted" }}
        >
          <ChakraRadioGroup.ItemIndicator
            boxSize="2"
            borderRadius="full"
            bg="accent.solid"
          />
        </ChakraRadioGroup.ItemControl>
        {children != null ? (
          <ChakraRadioGroup.ItemText
            fontSize="13.5px"
            fontWeight="400"
            color="fg"
            _disabled={{ color: "fg.disabled" }}
          >
            {children}
          </ChakraRadioGroup.ItemText>
        ) : null}
      </ChakraRadioGroup.Item>
    )
  },
)
