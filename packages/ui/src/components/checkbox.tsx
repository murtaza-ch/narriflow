"use client"

import { Checkbox as ChakraCheckbox } from "@chakra-ui/react"
import * as React from "react"

export interface CheckboxProps
  extends Omit<ChakraCheckbox.RootProps, "onCheckedChange"> {
  /** Simplified change handler — receives the resolved boolean. */
  onCheckedChange?: (checked: boolean) => void
  /** Props forwarded to the hidden native input (e.g. name, form). */
  inputProps?: React.ComponentProps<typeof ChakraCheckbox.HiddenInput>
}

/**
 * Blueline Checkbox on Chakra v3 Checkbox.
 * Square l1 box, border.control boundary, accent.solid fill when checked.
 */
export const Checkbox = React.forwardRef<HTMLLabelElement, CheckboxProps>(
  function Checkbox(props, ref) {
    const { children, onCheckedChange, inputProps, ...rest } = props

    return (
      <ChakraCheckbox.Root
        ref={ref}
        gap="2"
        cursor="pointer"
        _disabled={{ cursor: "not-allowed" }}
        onCheckedChange={(details) =>
          onCheckedChange?.(details.checked === true)
        }
        {...rest}
      >
        <ChakraCheckbox.HiddenInput {...inputProps} />
        <ChakraCheckbox.Control
          boxSize="4"
          borderRadius="l1"
          borderWidth="1px"
          borderColor="border.control"
          bg="bg.panel"
          color="transparent"
          transition="background 120ms ease, border-color 120ms ease"
          _checked={{
            bg: "accent.solid",
            borderColor: "accent.solid",
            color: "accent.contrast",
          }}
          _indeterminate={{
            bg: "accent.solid",
            borderColor: "accent.solid",
            color: "accent.contrast",
          }}
          _disabled={{
            borderColor: "border",
            bg: "bg.muted",
            _checked: { bg: "bg.muted", color: "fg.disabled" },
          }}
        >
          <ChakraCheckbox.Indicator boxSize="3" />
        </ChakraCheckbox.Control>
        {children != null ? (
          <ChakraCheckbox.Label
            fontSize="13.5px"
            fontWeight="400"
            color="fg"
            _disabled={{ color: "fg.disabled" }}
          >
            {children}
          </ChakraCheckbox.Label>
        ) : null}
      </ChakraCheckbox.Root>
    )
  },
)
