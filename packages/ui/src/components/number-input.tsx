"use client"

import { NumberInput as ChakraNumberInput } from "@chakra-ui/react"
import * as React from "react"

type NumberInputSize = "sm" | "md"

const inputHeights: Record<NumberInputSize, string> = {
  sm: "8",
  md: "9",
}

export interface NumberInputProps
  extends Omit<ChakraNumberInput.RootProps, "onValueChange" | "size"> {
  /** Simplified change handler — string value plus parsed number. */
  onValueChange?: (value: string, valueAsNumber: number) => void
  size?: NumberInputSize
  placeholder?: string
  /** Props forwarded to the inner input element. */
  inputProps?: ChakraNumberInput.InputProps
}

/**
 * Blueline NumberInput on Chakra v3 NumberInput.
 * Mono digits (textStyle data), border.control boundary, minimal steppers.
 */
export const NumberInput = React.forwardRef<HTMLDivElement, NumberInputProps>(
  function NumberInput(props, ref) {
    const {
      onValueChange,
      size = "md",
      placeholder,
      inputProps,
      ...rest
    } = props

    return (
      <ChakraNumberInput.Root
        ref={ref}
        onValueChange={(details) =>
          onValueChange?.(details.value, details.valueAsNumber)
        }
        {...rest}
      >
        <ChakraNumberInput.Control
          borderInlineStartWidth="1px"
          borderColor="border.control"
        >
          <ChakraNumberInput.IncrementTrigger
            color="fg.muted"
            bg="transparent"
            cursor="pointer"
            transition="background 120ms ease, color 120ms ease"
            _hover={{ bg: "bg.subtle", color: "fg" }}
            _disabled={{ color: "fg.disabled", cursor: "not-allowed" }}
          />
          <ChakraNumberInput.DecrementTrigger
            color="fg.muted"
            bg="transparent"
            cursor="pointer"
            transition="background 120ms ease, color 120ms ease"
            _hover={{ bg: "bg.subtle", color: "fg" }}
            _disabled={{ color: "fg.disabled", cursor: "not-allowed" }}
          />
        </ChakraNumberInput.Control>
        <ChakraNumberInput.Input
          h={inputHeights[size]}
          px="2.5"
          textStyle="data"
          fontSize="13.5px"
          bg="bg.panel"
          borderWidth="1px"
          borderColor="border.control"
          borderRadius="l2"
          color="fg"
          placeholder={placeholder}
          _placeholder={{ color: "fg.subtle" }}
          _disabled={{ color: "fg.disabled", bg: "bg.muted" }}
          {...inputProps}
        />
      </ChakraNumberInput.Root>
    )
  },
)
