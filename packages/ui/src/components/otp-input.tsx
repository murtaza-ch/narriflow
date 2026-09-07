"use client"

import { PinInput as ChakraPinInput } from "@chakra-ui/react"
import * as React from "react"

export interface OTPInputProps
  extends Omit<
    ChakraPinInput.RootProps,
    | "count"
    | "type"
    | "otp"
    | "value"
    | "defaultValue"
    | "onValueChange"
    | "onValueComplete"
  > {
  /** Number of digit boxes. Defaults to 6. */
  length?: number
  /** Value as a plain string, e.g. "482910". */
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** Fires once every box is filled. */
  onComplete?: (value: string) => void
}

const toArray = (
  value: string | undefined,
  length: number,
): string[] | undefined =>
  value === undefined ? undefined : value.split("").slice(0, length)

/**
 * Blueline OTPInput on Chakra v3 PinInput — 6 mono digit boxes with
 * auto-advance and paste handling built in (numeric, one-time-code).
 */
export const OTPInput = React.forwardRef<HTMLDivElement, OTPInputProps>(
  function OTPInput(props, ref) {
    const {
      length = 6,
      value,
      defaultValue,
      onValueChange,
      onComplete,
      ...rest
    } = props

    return (
      <ChakraPinInput.Root
        ref={ref}
        otp
        type="numeric"
        count={length}
        value={toArray(value, length)}
        defaultValue={toArray(defaultValue, length)}
        onValueChange={(details) => onValueChange?.(details.valueAsString)}
        onValueComplete={(details) => onComplete?.(details.valueAsString)}
        {...rest}
      >
        <ChakraPinInput.HiddenInput />
        <ChakraPinInput.Control display="flex" gap="2">
          {Array.from({ length }, (_, index) => (
            <ChakraPinInput.Input
              key={index}
              index={index}
              inputMode="numeric"
              w="9"
              h="10"
              p="0"
              textAlign="center"
              textStyle="data"
              fontSize="15px"
              bg="bg.panel"
              borderWidth="1px"
              borderColor="border.control"
              borderRadius="l2"
              color="fg"
              transition="border-color 120ms ease"
              _placeholder={{ color: "fg.subtle" }}
              _disabled={{ color: "fg.disabled", bg: "bg.muted" }}
            />
          ))}
        </ChakraPinInput.Control>
      </ChakraPinInput.Root>
    )
  },
)
