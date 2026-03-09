import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react"

const config = defineConfig({
  globalCss: {
    "html, body": {
      bg: "bg",
      color: "fg",
      scrollBehavior: "smooth",
    },
    "::selection": {
      bg: { _light: "{colors.accent.200}", _dark: "{colors.accent.800}" },
      color: { _light: "{colors.accent.900}", _dark: "{colors.accent.100}" },
    },
    "*:focus-visible": {
      outline: "2px solid",
      outlineColor: "{colors.accent.500}",
      outlineOffset: "2px",
    },
  },
  theme: {
    tokens: {
      fonts: {
        body: { value: "var(--font-geist-sans), system-ui, sans-serif" },
        heading: { value: "var(--font-geist-sans), system-ui, sans-serif" },
        mono: { value: "var(--font-geist-mono), monospace" },
      },
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
        accent: {
          50: { value: "#EEF2FF" },
          100: { value: "#E0E7FF" },
          200: { value: "#C7D2FE" },
          300: { value: "#A5B4FC" },
          400: { value: "#818CF8" },
          500: { value: "#6366F1" },
          600: { value: "#4F46E5" },
          700: { value: "#4338CA" },
          800: { value: "#3730A3" },
          900: { value: "#312E81" },
          950: { value: "#1E1B4B" },
        },
        success: {
          50: { value: "#F0FDF4" },
          100: { value: "#DCFCE7" },
          200: { value: "#BBF7D0" },
          300: { value: "#86EFAC" },
          400: { value: "#4ADE80" },
          500: { value: "#22C55E" },
          600: { value: "#16A34A" },
          700: { value: "#15803D" },
          800: { value: "#166534" },
          900: { value: "#14532D" },
          950: { value: "#052E16" },
        },
        warning: {
          50: { value: "#FFFBEB" },
          100: { value: "#FEF3C7" },
          200: { value: "#FDE68A" },
          300: { value: "#FCD34D" },
          400: { value: "#FBBF24" },
          500: { value: "#F59E0B" },
          600: { value: "#D97706" },
          700: { value: "#B45309" },
          800: { value: "#92400E" },
          900: { value: "#78350F" },
          950: { value: "#451A03" },
        },
        danger: {
          50: { value: "#FEF2F2" },
          100: { value: "#FEE2E2" },
          200: { value: "#FECACA" },
          300: { value: "#FCA5A5" },
          400: { value: "#F87171" },
          500: { value: "#EF4444" },
          600: { value: "#DC2626" },
          700: { value: "#B91C1C" },
          800: { value: "#991B1B" },
          900: { value: "#7F1D1D" },
          950: { value: "#450A0A" },
        },
      },
    },
    semanticTokens: {
      colors: {
        // Brand semantic tokens
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
          focusRing: { value: "{colors.accent.500}" },
        },
        // Accent semantic tokens
        accent: {
          solid: {
            value: { _light: "{colors.accent.600}", _dark: "{colors.accent.500}" },
          },
          contrast: {
            value: "#ffffff",
          },
          fg: {
            value: { _light: "{colors.accent.600}", _dark: "{colors.accent.400}" },
          },
          muted: {
            value: { _light: "{colors.accent.100}", _dark: "{colors.accent.900}" },
          },
          subtle: {
            value: { _light: "{colors.accent.50}", _dark: "{colors.accent.950}" },
          },
          emphasized: {
            value: { _light: "{colors.accent.200}", _dark: "{colors.accent.800}" },
          },
          focusRing: { value: "{colors.accent.500}" },
        },
        // Success semantic tokens
        success: {
          solid: {
            value: { _light: "{colors.success.600}", _dark: "{colors.success.500}" },
          },
          contrast: { value: "#ffffff" },
          fg: {
            value: { _light: "{colors.success.600}", _dark: "{colors.success.400}" },
          },
          muted: {
            value: { _light: "{colors.success.100}", _dark: "{colors.success.900}" },
          },
          subtle: {
            value: { _light: "{colors.success.50}", _dark: "{colors.success.950}" },
          },
          emphasized: {
            value: { _light: "{colors.success.200}", _dark: "{colors.success.800}" },
          },
          focusRing: { value: "{colors.success.500}" },
        },
        // Warning semantic tokens
        warning: {
          solid: {
            value: { _light: "{colors.warning.600}", _dark: "{colors.warning.500}" },
          },
          contrast: { value: "#ffffff" },
          fg: {
            value: { _light: "{colors.warning.600}", _dark: "{colors.warning.400}" },
          },
          muted: {
            value: { _light: "{colors.warning.100}", _dark: "{colors.warning.900}" },
          },
          subtle: {
            value: { _light: "{colors.warning.50}", _dark: "{colors.warning.950}" },
          },
          emphasized: {
            value: { _light: "{colors.warning.200}", _dark: "{colors.warning.800}" },
          },
          focusRing: { value: "{colors.warning.500}" },
        },
        // Danger semantic tokens
        danger: {
          solid: {
            value: { _light: "{colors.danger.600}", _dark: "{colors.danger.500}" },
          },
          contrast: { value: "#ffffff" },
          fg: {
            value: { _light: "{colors.danger.600}", _dark: "{colors.danger.400}" },
          },
          muted: {
            value: { _light: "{colors.danger.100}", _dark: "{colors.danger.900}" },
          },
          subtle: {
            value: { _light: "{colors.danger.50}", _dark: "{colors.danger.950}" },
          },
          emphasized: {
            value: { _light: "{colors.danger.200}", _dark: "{colors.danger.800}" },
          },
          focusRing: { value: "{colors.danger.500}" },
        },
        // Background tokens
        bg: {
          DEFAULT: {
            value: { _light: "#ffffff", _dark: "#0A0A0A" },
          },
          subtle: {
            value: { _light: "#FAFAFA", _dark: "#141414" },
          },
          muted: {
            value: { _light: "#F5F5F5", _dark: "#1C1C1C" },
          },
          panel: {
            value: { _light: "#FFFFFF", _dark: "#171717" },
          },
          accent: {
            value: { _light: "{colors.accent.50}", _dark: "{colors.accent.950}" },
          },
        },
        // Foreground tokens
        fg: {
          DEFAULT: {
            value: { _light: "#171717", _dark: "#EDEDED" },
          },
          muted: {
            value: { _light: "#737373", _dark: "#8C8C8C" },
          },
          subtle: {
            value: { _light: "#A3A3A3", _dark: "#5C5C5C" },
          },
          accent: {
            value: { _light: "{colors.accent.600}", _dark: "{colors.accent.400}" },
          },
        },
        // Border tokens
        border: {
          DEFAULT: {
            value: { _light: "#E5E5E5", _dark: "#262626" },
          },
          subtle: {
            value: { _light: "#F0F0F0", _dark: "#1F1F1F" },
          },
          accent: {
            value: { _light: "{colors.accent.200}", _dark: "{colors.accent.800}" },
          },
        },
      },
    },
  },
})

export const system = createSystem(defaultConfig, config)
