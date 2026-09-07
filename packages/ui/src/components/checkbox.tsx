"use client";

import { Checkbox as ChakraCheckbox } from "@chakra-ui/react";
import * as React from "react";

export interface CheckboxProps extends Omit<ChakraCheckbox.RootProps, "onCheckedChange"> {
  /** Simplified change handler — receives the resolved boolean. */
  onCheckedChange?: (checked: boolean) => void;
  /** Props forwarded to the hidden native input (e.g. name, form). */
  inputProps?: React.ComponentProps<typeof ChakraCheckbox.HiddenInput>;
}

export const Checkbox = React.forwardRef<HTMLLabelElement, CheckboxProps>(
  function Checkbox(props, ref) {
    const { children, onCheckedChange, inputProps, ...rest } = props;

    return (
      <ChakraCheckbox.Root
        ref={ref}
        colorPalette="brand"
        onCheckedChange={(details) => onCheckedChange?.(details.checked === true)}
        {...rest}
      >
        <ChakraCheckbox.HiddenInput {...inputProps} />
        <ChakraCheckbox.Control>
          <ChakraCheckbox.Indicator />
        </ChakraCheckbox.Control>
        {children != null ? <ChakraCheckbox.Label>{children}</ChakraCheckbox.Label> : null}
      </ChakraCheckbox.Root>
    );
  },
);
