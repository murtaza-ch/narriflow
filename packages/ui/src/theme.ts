import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react"

const config = defineConfig({
  globalCss: {
    "html, body": {
      bg: "bg",
      color: "fg",
    },
  },
  theme: {
    tokens: {
      colors: {
        brand: {
          50: { value: "#fafafa" },
          100: { value: "#f5f5f5" },
          200: { value: "#e5e5e5" },
          300: { value: "#d4d4d4" },
          400: { value: "#a3a3a3" },
          500: { value: "#737373" },
          600: { value: "#525252" },
          700: { value: "#404040" },
          800: { value: "#333333" },
          900: { value: "#262626" },
          950: { value: "#1a1a1a" },
        },
      },
    },
    semanticTokens: {
      colors: {
        brand: {
          solid: {
            value: { _light: "{colors.brand.900}", _dark: "{colors.brand.200}" },
          },
          contrast: {
            value: { _light: "{colors.brand.50}", _dark: "{colors.brand.950}" },
          },
          fg: {
            value: { _light: "{colors.brand.900}", _dark: "{colors.brand.200}" },
          },
          muted: {
            value: { _light: "{colors.brand.100}", _dark: "{colors.brand.800}" },
          },
          subtle: {
            value: { _light: "{colors.brand.50}", _dark: "{colors.brand.950}" },
          },
          emphasized: {
            value: { _light: "{colors.brand.300}", _dark: "{colors.brand.700}" },
          },
          focusRing: { value: "{colors.brand.500}" },
        },
        bg: {
          DEFAULT: {
            value: { _light: "#ffffff", _dark: "#1a1a1a" },
          },
          subtle: {
            value: { _light: "#f5f5f5", _dark: "#333333" },
          },
          muted: {
            value: { _light: "#f5f5f5", _dark: "#333333" },
          },
        },
        fg: {
          DEFAULT: {
            value: { _light: "#1a1a1a", _dark: "#fafafa" },
          },
          muted: {
            value: { _light: "#737373", _dark: "#a3a3a3" },
          },
        },
        border: {
          DEFAULT: {
            value: { _light: "#e5e5e5", _dark: "rgba(255,255,255,0.1)" },
          },
        },
      },
    },
  },
})

export const system = createSystem(defaultConfig, config)
