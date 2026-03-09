import {
  Button as ChakraButton,
  IconButton as ChakraIconButton,
} from "@chakra-ui/react"
import type { ButtonProps as ChakraButtonProps } from "@chakra-ui/react"
import * as React from "react"

export interface ButtonProps extends ChakraButtonProps {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    return <ChakraButton ref={ref} colorPalette="accent" {...props} />
  },
)

export const IconButton = React.forwardRef<HTMLButtonElement, ChakraButtonProps>(
  function IconButton(props, ref) {
    return <ChakraIconButton ref={ref} colorPalette="accent" {...props} />
  },
)
