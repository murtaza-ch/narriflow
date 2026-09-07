"use client"

import { Slider as ChakraSlider } from "@chakra-ui/react"
import * as React from "react"

export type SliderValue = number | number[]

export interface SliderProps
  extends Omit<
    ChakraSlider.RootProps,
    "value" | "defaultValue" | "onValueChange" | "onValueChangeEnd"
  > {
  /** Single number for one thumb, number[] for a range. */
  value?: SliderValue
  defaultValue?: SliderValue
  /** Receives the same shape it was given (number in, number out). */
  onValueChange?: (value: SliderValue) => void
  onValueChangeEnd?: (value: SliderValue) => void
  label?: React.ReactNode
  /** Show the current value(s) beside the label. */
  showValueText?: boolean
}

const toArray = (value: SliderValue | undefined): number[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value]

/**
 * Blueline Slider on Chakra v3 Slider — single or range values.
 * 3px bg.muted track, accent.solid filled range, 14px bordered thumbs.
 */
export const Slider = React.forwardRef<HTMLDivElement, SliderProps>(
  function Slider(props, ref) {
    const {
      value,
      defaultValue,
      onValueChange,
      onValueChangeEnd,
      label,
      showValueText,
      ...rest
    } = props

    const isRange = Array.isArray(value ?? defaultValue)
    const emit = (
      handler: ((value: SliderValue) => void) | undefined,
      next: number[],
    ) => {
      if (!handler) return
      handler(isRange ? next : next[0] ?? 0)
    }

    return (
      <ChakraSlider.Root
        ref={ref}
        value={toArray(value)}
        defaultValue={toArray(defaultValue)}
        onValueChange={(details) => emit(onValueChange, details.value)}
        onValueChangeEnd={(details) => emit(onValueChangeEnd, details.value)}
        {...rest}
      >
        {label != null || showValueText ? (
          <ChakraSlider.Label
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            fontSize="13px"
            fontWeight="500"
            color="fg"
            mb="1.5"
          >
            <span>{label}</span>
            {showValueText ? (
              <ChakraSlider.ValueText
                textStyle="data"
                fontSize="12px"
                color="fg.muted"
              />
            ) : null}
          </ChakraSlider.Label>
        ) : null}
        <ChakraSlider.Control>
          <ChakraSlider.Track h="3px" bg="bg.muted" borderRadius="full">
            <ChakraSlider.Range bg="accent.solid" />
          </ChakraSlider.Track>
          <ChakraSlider.Thumbs
            boxSize="3.5"
            bg="bg.panel"
            borderWidth="1px"
            borderColor="border.control"
            borderRadius="full"
            boxShadow="card"
            cursor="grab"
            _active={{ cursor: "grabbing" }}
          />
        </ChakraSlider.Control>
      </ChakraSlider.Root>
    )
  },
)
