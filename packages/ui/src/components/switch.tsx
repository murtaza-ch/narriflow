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

/** App-wide Chakra switch with a filled track and accent checked state. The
 *  unselected track (`bg.track`) and both thumbs keep at least 3:1 contrast
 *  on the page, panels and soft rows in both colour modes. */
export const Switch = React.forwardRef<HTMLLabelElement, SwitchProps>(
  function Switch(props, ref) {
    const {
      children,
      onCheckedChange,
      inputProps,
      size = "sm",
      variant = "solid",
      colorPalette = "accent",
      ...rest
    } = props

    return (
      <ChakraSwitch.Root
        ref={ref}
        size={size}
        variant={variant}
        colorPalette={colorPalette}
        gap="2"
        cursor="pointer"
        _disabled={{ cursor: "not-allowed" }}
        onCheckedChange={(details) => onCheckedChange?.(details.checked)}
        {...rest}
      >
        <ChakraSwitch.HiddenInput {...inputProps} />
        <ChakraSwitch.Control bg="bg.track" _checked={{ bg: "colorPalette.solid" }}>
          {/* White on the grey track; on the accent fill, the accent's own
              contrast colour (dark on the pale dark-mode accent, where white
              measured 2.23:1). */}
          <ChakraSwitch.Thumb bg="white" _checked={{ bg: "colorPalette.contrast" }} />
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
