"use client"

import { ChakraProvider } from "@chakra-ui/react"
import { ColorModeProvider } from "./components/color-mode"
import { system } from "./theme"

export function Provider({ children }: { children: React.ReactNode }) {
  return (
    <ChakraProvider value={system}>
      <ColorModeProvider>{children}</ColorModeProvider>
    </ChakraProvider>
  )
}
