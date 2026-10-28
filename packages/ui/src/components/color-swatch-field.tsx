"use client"

import {
  Box,
  ColorPicker,
  Flex,
  Portal,
  Stack,
  Text,
  chakra,
  parseColor,
  type Color,
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

const toHex = (color: Color) => normalizeHex(color.toString("hex")) ?? "#000000"

// User colors sit on any surface; a faint neutral ring keeps white on
// porcelain and graphite on graphite visible.
const SWATCH_RING = "inset 0 0 0 1px rgba(128, 128, 128, 0.22)"

export interface ColorSwatchFieldProps {
  label?: string
  /** Plain hex string — user-chosen colors intentionally stay literal. */
  value: string
  onChange: (hex: string) => void
  /** Common swatch hexes shown as a quick-pick row. */
  swatches?: string[]
  disabled?: boolean
  /** `field`: a soft pill with the swatch and hex. `tile`: a large color block for palettes. */
  variant?: "field" | "tile"
  /** Shown under the label on a tile, e.g. what the color is used for. */
  hint?: string
}

/**
 * Blueline color field: a trigger showing the current color that opens a
 * picker (spectrum, hue, eyedropper, hex and quick swatches). Value is a raw
 * hex string by design.
 */
export const ColorSwatchField = React.forwardRef<
  HTMLButtonElement,
  ColorSwatchFieldProps
>(function ColorSwatchField(props, ref) {
  const { label, value, onChange, swatches = [], disabled, variant = "field", hint } = props
  const [color, setColor] = React.useState(() => parseColor(normalizeHex(value) ?? "#000000"))

  // Follow external changes; keep the picker's own color (and hue) while it drives the value.
  React.useEffect(() => {
    const next = normalizeHex(value)
    if (next && next !== toHex(color)) setColor(parseColor(next))
  }, [value, color])

  return (
    <ColorPicker.Root
      value={color}
      format="hsba"
      disabled={disabled}
      // Mount on open: the eyedropper renders differently on the server, and closed pickers needn't exist.
      lazyMount
      unmountOnExit
      positioning={{ placement: "bottom-start", gutter: 6 }}
      onValueChange={(details) => {
        setColor(details.value)
        const hex = toHex(details.value)
        if (hex !== normalizeHex(value)) onChange(hex)
      }}
      w={variant === "tile" ? "full" : undefined}
      gap="1.5"
    >
      {label && variant === "field" ? (
        <ColorPicker.Label fontSize="13px" fontWeight="500" color="fg">
          {label}
        </ColorPicker.Label>
      ) : null}
      <ColorPicker.Control>
        {variant === "tile" ? (
          <ColorPicker.Trigger
            ref={ref}
            aria-label={label ? `${label} color ${value}` : `Color ${value}`}
            asChild
          >
            <chakra.button
              type="button"
              w="full"
              h="auto"
              p="0"
              display="block"
              textAlign="left"
              cursor={disabled ? "default" : "pointer"}
              bg="transparent"
              borderWidth="0"
              className="group"
            >
              <Box
                h={{ base: "20", md: "24" }}
                borderRadius="l2"
                transition="transform 160ms ease"
                _groupHover={disabled ? undefined : { transform: "translateY(-2px)" }}
                style={{ background: value }}
              />
              <Stack gap="0" mt="2.5">
                {label ? (
                  <Text fontSize="13px" fontWeight="500" color="fg">
                    {label}
                  </Text>
                ) : null}
                <Text textStyle="data" fontSize="12px" color="fg.muted" textTransform="uppercase">
                  {value}
                </Text>
                {hint ? (
                  <Text fontSize="12px" color="fg.subtle" mt="1">
                    {hint}
                  </Text>
                ) : null}
              </Stack>
            </chakra.button>
          </ColorPicker.Trigger>
        ) : (
          <ColorPicker.Trigger
            ref={ref}
            display="inline-flex"
            alignItems="center"
            gap="2"
            h="9"
            w="auto"
            px="2.5"
            bg="bg.soft"
            borderWidth="1px"
            borderColor="transparent"
            borderRadius="control"
            cursor="pointer"
            transition="background 120ms ease"
            _hover={{ bg: "bg.softHover" }}
            _disabled={{ cursor: "not-allowed", opacity: 1, color: "fg.disabled" }}
          >
            <Box
              boxSize="4"
              borderRadius="l1"
              boxShadow={SWATCH_RING}
              flexShrink={0}
              style={{ background: value }}
            />
            <Text textStyle="data" fontSize="12.5px" color="fg" textTransform="uppercase">
              {value}
            </Text>
          </ColorPicker.Trigger>
        )}
      </ColorPicker.Control>
      <Portal>
        <ColorPicker.Positioner>
          <ColorPicker.Content
            w="248px"
            bg="bg.raised"
            borderWidth="1px"
            borderColor="border.card"
            borderRadius="l2"
            boxShadow="none"
            p="3"
            gap="3"
          >
            <ColorPicker.Area h="140px" borderRadius="8px" />
            <Flex align="center" gap="2">
              <ColorPicker.EyeDropper size="xs" variant="subtle" aria-label="Pick a color from the screen" />
              <ColorPicker.ChannelSlider channel="hue" flex="1" />
            </Flex>
            <Flex align="center" gap="2">
              <ColorPicker.ValueSwatch boxSize="7" borderRadius="l1" boxShadow={SWATCH_RING} flexShrink={0} />
              <ColorPicker.ChannelInput
                channel="hex"
                aria-label="Hex color"
                spellCheck={false}
                textStyle="data"
                fontSize="12.5px"
                h="8"
                px="2.5"
                bg="bg.soft"
                borderWidth="1px"
                borderColor="transparent"
                borderRadius="control"
                textTransform="uppercase"
                _focusVisible={{ borderColor: "border.focus", outline: "none" }}
              />
            </Flex>
            {swatches.length > 0 ? (
              <ColorPicker.SwatchGroup display="grid" gridTemplateColumns="repeat(6, minmax(0, 1fr))" gap="2">
                {swatches.map((swatch) => (
                  <ColorPicker.SwatchTrigger
                    key={swatch}
                    value={swatch}
                    aria-label={`Use color ${swatch}`}
                    cursor="pointer"
                    borderRadius="6px"
                    w="full"
                    h="auto"
                  >
                    <ColorPicker.Swatch value={swatch} w="full" h="auto" aspectRatio={1} borderRadius="6px" boxShadow={SWATCH_RING} />
                  </ColorPicker.SwatchTrigger>
                ))}
              </ColorPicker.SwatchGroup>
            ) : null}
          </ColorPicker.Content>
        </ColorPicker.Positioner>
      </Portal>
    </ColorPicker.Root>
  )
})
