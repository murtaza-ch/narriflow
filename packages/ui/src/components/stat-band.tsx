import { Grid, HStack, Stack, Text, type GridProps } from "@chakra-ui/react"
import type { ReactNode } from "react"
import { Meter, type MeterPalette } from "./meter"

export interface StatBandProps extends GridProps {
  /** Column count at md+ (collapses to 2 on sm, 1 on base). Default 4. */
  columns?: number
  children: ReactNode
}

function StatBandRoot({ columns = 4, children, ...rest }: StatBandProps) {
  return (
    <Grid
      layerStyle="band"
      gridTemplateColumns={{
        base: "1fr",
        sm: "repeat(2, minmax(0, 1fr))",
        md: `repeat(${columns}, minmax(0, 1fr))`,
      }}
      // Spacing separates the stats; no divider rules.
      columnGap="8"
      rowGap="6"
      {...rest}
    >
      {children}
    </Grid>
  )
}

export interface StatBandItemProps {
  /** Label above the numeral. */
  label: string
  /** The stat, set in tabular figures. */
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
      <Text textStyle="eyebrow" color="fg.muted">
        {label}
      </Text>
      <HStack align="baseline" gap="1.5">
        <Text
          fontFamily="body"
          fontWeight="500"
          fontVariantNumeric="tabular-nums"
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
