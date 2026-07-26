import { Grid, HStack, Stack, Text, type GridProps } from "@chakra-ui/react"
import type { ReactNode } from "react"
import { Meter, type MeterPalette } from "./meter"

export interface StatBandProps extends GridProps {
  /** Column count at md+ (collapses to 2 on sm, 1 on base). Default 4. */
  columns?: number
  children: ReactNode
}

/**
 * StatBand — KPI/definition rows drawn as a band: heavy 1.5px ink top-rule,
 * hairline column dividers, mono numerals. No wrapper box, no cards.
 * Compose with `StatBand.Item`. Server-component friendly.
 */
function StatBandRoot({ columns = 4, children, ...rest }: StatBandProps) {
  return (
    <Grid
      layerStyle="band"
      gridTemplateColumns={{
        base: "1fr",
        sm: "repeat(2, minmax(0, 1fr))",
        md: `repeat(${columns}, minmax(0, 1fr))`,
      }}
      columnGap="0"
      rowGap={{ base: "0", sm: "6" }}
      css={{
        // Hairline column dividers; row-start items carry no divider.
        "& > [data-stat-item]": {
          borderColor: "border",
          borderStyle: "solid",
          borderWidth: "0",
          borderInlineStartWidth: { sm: "1px" },
          paddingInlineStart: { sm: "5" },
          paddingInlineEnd: { sm: "5" },
        },
        // Stacked (1-col) layout: hairline row dividers instead.
        "& > [data-stat-item] + [data-stat-item]": {
          borderTopWidth: { base: "1px", sm: "0" },
          paddingTop: { base: "4", sm: "0" },
          marginTop: { base: "4", sm: "0" },
        },
        // 2-col rows start on odd items.
        "& > [data-stat-item]:nth-of-type(2n + 1)": {
          borderInlineStartWidth:
            columns === 2 ? { sm: "0" } : { sm: "0", md: "1px" },
          paddingInlineStart:
            columns === 2 ? { sm: "0" } : { sm: "0", md: "5" },
        },
        // md rows start every `columns` items.
        ...(columns !== 2
          ? {
              [`& > [data-stat-item]:nth-of-type(${columns}n + 1)`]: {
                borderInlineStartWidth: { md: "0" },
                paddingInlineStart: { md: "0" },
              },
            }
          : {}),
      }}
      {...rest}
    >
      {children}
    </Grid>
  )
}

export interface StatBandItemProps {
  /** Eyebrow label above the numeral. */
  label: string
  /** The stat — set numerals in mono via the item itself. */
  value: ReactNode
  /** Optional 0–100 meter rendered as a 3px track under the value. */
  meter?: number
  /** Fill palette for the meter (default accent). */
  meterPalette?: MeterPalette
  /** Small node rendered after the numeral (unit, delta, chip). */
  suffix?: ReactNode
}

function StatBandItem({ label, value, meter, meterPalette, suffix }: StatBandItemProps) {
  return (
    <Stack data-stat-item gap="1" minW="0">
      <Text textStyle="eyebrow" color="fg.subtle">
        {label}
      </Text>
      <HStack align="baseline" gap="1.5">
        <Text
          textStyle="data"
          fontSize={{ base: "26px", md: "28px" }}
          lineHeight="1.15"
          color="fg"
        >
          {value}
        </Text>
        {suffix}
      </HStack>
      {meter !== undefined && (
        <Meter
          value={meter}
          palette={meterPalette}
          maxW="120px"
          mt="1"
          aria-label={`${label} progress`}
        />
      )}
    </Stack>
  )
}

export const StatBand = Object.assign(StatBandRoot, { Item: StatBandItem })
export { StatBandItem }
