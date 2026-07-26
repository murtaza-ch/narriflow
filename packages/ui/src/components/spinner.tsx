import { Box, type BoxProps } from "@chakra-ui/react"
import * as React from "react"

type SpinnerSize = "xs" | "sm" | "md"

const sizes: Record<SpinnerSize, { boxSize: string; borderWidth: string }> = {
  xs: { boxSize: "3", borderWidth: "1.5px" },
  sm: { boxSize: "4", borderWidth: "2px" },
  md: { boxSize: "6", borderWidth: "2px" },
}

export interface SpinnerProps extends Omit<BoxProps, "size"> {
  size?: SpinnerSize
}

/**
 * Blueline Spinner — a minimal ring (accent.solid lead edge over a border
 * track) driven by the theme `spin` animation token. Replaces the inline
 * @keyframes spin copies scattered across the app.
 */
export const Spinner = React.forwardRef<HTMLDivElement, SpinnerProps>(
  function Spinner(props, ref) {
    const { size = "sm", ...rest } = props
    const config = sizes[size]

    return (
      <Box
        ref={ref}
        role="status"
        aria-label="Loading"
        display="inline-block"
        flexShrink={0}
        boxSize={config.boxSize}
        borderWidth={config.borderWidth}
        borderStyle="solid"
        borderColor="border"
        borderTopColor="accent.solid"
        borderRadius="full"
        animation="spin"
        {...rest}
      />
    )
  },
)
