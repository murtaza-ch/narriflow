"use client"

import {
  Box,
  Input,
  Popover,
  Portal,
  SimpleGrid,
  Stack,
  Text,
  chakra,
} from "@chakra-ui/react"
import * as React from "react"

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** Expand #abc → #aabbcc and lowercase; returns null when not a hex. */
const normalizeHex = (raw: string): string | null => {
  const match = HEX_RE.exec(raw.trim())
  if (!match) return null
  let hex = (match[1] ?? "").toLowerCase()
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("")
  }
  return `#${hex}`
}

export interface ColorSwatchFieldProps {
  label?: string
  /** Plain hex string — user-chosen colors intentionally stay literal. */
  value: string
  onChange: (hex: string) => void
  /** Common swatch hexes shown as a quick-pick grid. */
  swatches?: string[]
  disabled?: boolean
}

/**
 * Blueline labeled color field. The trigger is a bordered well showing the
 * current swatch + hex; it opens a true-card Popover with a hex input and a
 * quick-pick swatch grid. Value is a raw hex string by design.
 */
export const ColorSwatchField = React.forwardRef<
  HTMLButtonElement,
  ColorSwatchFieldProps
>(function ColorSwatchField(props, ref) {
  const { label, value, onChange, swatches = [], disabled } = props
  const triggerId = React.useId()
  const [draft, setDraft] = React.useState(value)

  // Keep the draft in sync when the committed value changes externally.
  React.useEffect(() => {
    setDraft(value)
  }, [value])

  const commitDraft = () => {
    const hex = normalizeHex(draft)
    if (hex) {
      onChange(hex)
      setDraft(hex)
    } else {
      setDraft(value)
    }
  }

  return (
    <Stack gap="1.5" align="flex-start">
      {label ? (
        <chakra.label
          htmlFor={triggerId}
          fontSize="13px"
          fontWeight="500"
          color="fg"
        >
          {label}
        </chakra.label>
      ) : null}
      <Popover.Root positioning={{ placement: "bottom-start" }}>
        <Popover.Trigger
          ref={ref}
          id={triggerId}
          disabled={disabled}
          display="inline-flex"
          alignItems="center"
          gap="2"
          h="9"
          px="2.5"
          bg="bg.panel"
          borderWidth="1px"
          borderColor="border.control"
          borderRadius="l2"
          cursor="pointer"
          transition="border-color 120ms ease"
          _hover={{ borderColor: "border.emphasized" }}
          _disabled={{ cursor: "not-allowed", opacity: 1, color: "fg.disabled" }}
        >
          <Box
            boxSize="4"
            borderRadius="l1"
            borderWidth="1px"
            borderColor="border.control"
            flexShrink={0}
            style={{ background: value }}
          />
          <Text textStyle="data" fontSize="12.5px" color="fg">
            {value}
          </Text>
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content
              w="220px"
              bg="bg.panel"
              borderWidth="1px"
              borderColor="border"
              borderRadius="l3"
              boxShadow="card"
              p="3"
            >
              <Stack gap="2.5">
                <Input
                  size="sm"
                  textStyle="data"
                  fontSize="12.5px"
                  bg="bg.panel"
                  borderColor="border.control"
                  borderRadius="l2"
                  value={draft}
                  aria-label="Hex color"
                  spellCheck={false}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commitDraft}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      commitDraft()
                    }
                  }}
                />
                {swatches.length > 0 ? (
                  <SimpleGrid columns={6} gap="1.5">
                    {swatches.map((swatch) => (
                      <chakra.button
                        key={swatch}
                        type="button"
                        aria-label={`Use color ${swatch}`}
                        boxSize="6"
                        borderRadius="l1"
                        borderWidth="1px"
                        borderColor="border.control"
                        cursor="pointer"
                        transition="border-color 120ms ease"
                        _hover={{ borderColor: "border.emphasized" }}
                        style={{ background: swatch }}
                        onClick={() => {
                          onChange(normalizeHex(swatch) ?? swatch)
                        }}
                      />
                    ))}
                  </SimpleGrid>
                ) : null}
              </Stack>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
    </Stack>
  )
})
