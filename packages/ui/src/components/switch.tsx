"use client"

import { Switch as ChakraSwitch } from "@chakra-ui/react"
import * as React from "react"

export interface SwitchProps
  extends Omit<ChakraSwitch.RootProps, "onCheckedChange"> {
  /** Simplified change handler — receives the resolved boolean. */
  onCheckedChange?: (checked: boolean) => void
  /** Props forwarded to the hidden native input (e.g. name, form). */
  inputProps?: React.ComponentProps<typeof ChakraSwitch.HiddenInput>
}

/**
 * Blueline Switch on Chakra v3 Switch.
 * Track: bg.muted with a border.control boundary → accent.solid when checked.
 */
export const Switch = React.forwardRef<HTMLLabelElement, SwitchProps>(
  function Switch(props, ref) {
    const { children, onCheckedChange, inputProps, size = "sm", ...rest } =
      props

    return (
      <ChakraSwitch.Root
        ref={ref}
        size={size}
        gap="2"
        cursor="pointer"
        _disabled={{ cursor: "not-allowed" }}
        onCheckedChange={(details) => onCheckedChange?.(details.checked)}
        {...rest}
      >
        <ChakraSwitch.HiddenInput {...inputProps} />
        <ChakraSwitch.Control
          bg="bg.muted"
          borderWidth="1px"
          borderColor="border.control"
          transition="background 120ms ease, border-color 120ms ease"
          _checked={{ bg: "accent.solid", borderColor: "accent.solid" }}
          _disabled={{ bg: "bg.muted", borderColor: "border" }}
        >
          <ChakraSwitch.Thumb
            bg="bg.panel"
            borderWidth="1px"
            borderColor="border.control"
            _checked={{
              bg: "accent.contrast",
              borderColor: "accent.contrast",
            }}
          />
        </ChakraSwitch.Control>
        {children != null ? (
          <ChakraSwitch.Label
            fontSize="13.5px"
            fontWeight="400"
            color="fg"
            _disabled={{ color: "fg.disabled" }}
          >
            {children}
          </ChakraSwitch.Label>
        ) : null}
      </ChakraSwitch.Root>
    )
  },
)
