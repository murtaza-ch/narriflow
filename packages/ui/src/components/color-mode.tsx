"use client"

import { ThemeProvider, useTheme } from "next-themes"
import type { ThemeProviderProps } from "next-themes"

export function ColorModeProvider(props: ThemeProviderProps) {
  return (
    <ThemeProvider attribute="class" disableTransitionOnChange {...props} />
  )
}

export function useColorMode() {
  const { resolvedTheme, setTheme } = useTheme()
  return {
    colorMode: resolvedTheme,
    setColorMode: setTheme,
    toggleColorMode: () =>
      setTheme(resolvedTheme === "dark" ? "light" : "dark"),
  }
}

export function useColorModeValue<T>(light: T, dark: T) {
  const { colorMode } = useColorMode()
  return colorMode === "dark" ? dark : light
}
