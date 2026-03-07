import { Badge as ChakraBadge } from "@chakra-ui/react"
import type { BadgeProps as ChakraBadgeProps } from "@chakra-ui/react"
import * as React from "react"

export interface BadgeProps extends ChakraBadgeProps {}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  function Badge(props, ref) {
    return <ChakraBadge ref={ref} {...props} />
  },
)
