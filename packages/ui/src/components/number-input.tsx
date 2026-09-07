"use client";

import { NumberInput as ChakraNumberInput } from "@chakra-ui/react";
import * as React from "react";

type NumberInputSize = "sm" | "md";

export interface NumberInputProps
  extends Omit<ChakraNumberInput.RootProps, "onValueChange" | "size"> {
  /** Simplified change handler — string value plus parsed number. */
  onValueChange?: (value: string, valueAsNumber: number) => void;
  size?: NumberInputSize;
  placeholder?: string;
  /** Props forwarded to the inner input element. */
  inputProps?: ChakraNumberInput.InputProps;
}

export const NumberInput = React.forwardRef<HTMLDivElement, NumberInputProps>(
  function NumberInput(props, ref) {
    const { onValueChange, size = "md", placeholder, inputProps, ...rest } = props;

    return (
      <ChakraNumberInput.Root
        ref={ref}
        size={size}
        onValueChange={(details) => onValueChange?.(details.value, details.valueAsNumber)}
        {...rest}
      >
        <ChakraNumberInput.Control>
          <ChakraNumberInput.IncrementTrigger />
          <ChakraNumberInput.DecrementTrigger />
        </ChakraNumberInput.Control>
        <ChakraNumberInput.Input placeholder={placeholder} {...inputProps} />
      </ChakraNumberInput.Root>
    );
  },
);
