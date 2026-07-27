import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react"

/**
 * Narriflow "Blueline" design language.
 *
 * Named after the pre-press blueline proof — fitting for a tool that proofs
 * clips before publishing. Swiss porcelain light mode structured by drawn
 * rules instead of boxes, a fully-designed graphite dark mode, and a single
 * ultramarine signal. Display type is Archivo (--font-display, width axis),
 * body is Geist Sans, data/timecodes are Geist Mono.
 *
 * Structure is drawn, not lifted: 1.5px ink section rules, hairline row
 * dividers, weight and position. True cards (bg.panel + shadow) are reserved
 * for surfaces where elevation means something: modals, popovers, menus,
 * pickers, toasts, and draggable objects. Footage always sits in a well —
 * never raw on white.
 *
 * The studio editor chrome is permanently graphite via the studio.* tokens
 * (mode-invariant). User-chosen caption/brand color values stay literal.
 */
const config = defineConfig({
  globalCss: {
    "html, body": {
      bg: "bg",
      color: "fg",
      scrollBehavior: "smooth",
      fontFeatureSettings: '"ss03", "cv01"',
    },
    "::selection": {
      bg: { _light: "{colors.accent.100}", _dark: "{colors.accent.900}" },
      color: { _light: "{colors.accent.950}", _dark: "{colors.accent.100}" },
    },
    "*:focus-visible": {
      outline: "2px solid",
      outlineColor: "{colors.accent.solid}",
      outlineOffset: "2px",
      borderRadius: "4px",
    },
    "*::-webkit-scrollbar": {
      width: "10px",
      height: "10px",
    },
    "*::-webkit-scrollbar-track": {
      background: "transparent",
    },
    "*::-webkit-scrollbar-thumb": {
      background: { _light: "#D4D7DC", _dark: "#303845" },
      borderRadius: "full",
      border: "3px solid transparent",
      backgroundClip: "padding-box",
    },
    "*::-webkit-scrollbar-thumb:hover": {
      background: { _light: "#B8BCC4", _dark: "#3E4756" },
      border: "3px solid transparent",
      backgroundClip: "padding-box",
    },
    html: {
      "@media (prefers-reduced-motion: reduce)": {
        "& *, & *::before, & *::after": {
          animationDuration: "0.01ms !important",
          animationIterationCount: "1 !important",
          transitionDuration: "0.01ms !important",
        },
      },
    },
  },
  theme: {
    tokens: {
      fonts: {
        body: { value: "var(--font-geist-sans), system-ui, sans-serif" },
        heading: {
          value:
            "var(--font-display), var(--font-geist-sans), system-ui, sans-serif",
        },
        display: {
          value:
            "var(--font-display), var(--font-geist-sans), system-ui, sans-serif",
        },
        mono: { value: "var(--font-geist-mono), monospace" },
      },
      // Cool graphite neutrals — slightly blue-biased, never crushed black.
      colors: {
        brand: {
          50: { value: "#F7F8F9" },
          100: { value: "#F2F3F5" },
          200: { value: "#E2E4E9" },
          300: { value: "#C9CDD4" },
          400: { value: "#9AA3B0" },
          500: { value: "#6E747E" },
          600: { value: "#585E69" },
          700: { value: "#3E4756" },
          800: { value: "#242A33" },
          900: { value: "#171B21" },
          950: { value: "#0E1013" },
        },
        // Signal ultramarine — the blueline.
        accent: {
          50: { value: "#EEF0FE" },
          100: { value: "#DFE3FD" },
          200: { value: "#C3CAFB" },
          300: { value: "#9DA8F8" },
          400: { value: "#7583F4" },
          500: { value: "#4A5AF0" },
          600: { value: "#2438E8" },
          700: { value: "#1C2CC4" },
          800: { value: "#1A279C" },
          900: { value: "#1B247A" },
          950: { value: "#101347" },
        },
        success: {
          50: { value: "#F0FBF4" },
          100: { value: "#DCF6E6" },
          200: { value: "#BCEDCF" },
          300: { value: "#8ADDAC" },
          400: { value: "#4CC38A" },
          500: { value: "#2AA26B" },
          600: { value: "#1D8A54" },
          700: { value: "#1D7A45" },
          800: { value: "#1B5E39" },
          900: { value: "#174D30" },
          950: { value: "#082A18" },
        },
        warning: {
          50: { value: "#FDF9EC" },
          100: { value: "#FAF0CE" },
          200: { value: "#F5DF98" },
          300: { value: "#EFC862" },
          400: { value: "#E5A13D" },
          500: { value: "#CB8322" },
          600: { value: "#A96617" },
          700: { value: "#8A5A00" },
          800: { value: "#6F4310" },
          900: { value: "#5C3811" },
          950: { value: "#351C05" },
        },
        danger: {
          50: { value: "#FEF2F1" },
          100: { value: "#FEE3E1" },
          200: { value: "#FDCBC8" },
          300: { value: "#FAA7A2" },
          400: { value: "#F26D6D" },
          500: { value: "#E5484D" },
          600: { value: "#C42B1C" },
          700: { value: "#A52519" },
          800: { value: "#88221A" },
          900: { value: "#71221C" },
          950: { value: "#3D0E0A" },
        },
      },
      radii: {
        l1: { value: "0.25rem" },
        l2: { value: "0.4375rem" },
        l3: { value: "0.625rem" },
      },
      shadows: {
        // Near-none in light — structure is drawn, not lifted. One ambient
        // elevation shadow for true cards (modals, menus, toasts).
        card: {
          value: "0 1px 2px rgba(14, 16, 19, 0.05)",
        },
        cardHover: {
          value: "0 1px 3px rgba(14, 16, 19, 0.06), 0 8px 24px rgba(14, 16, 19, 0.09)",
        },
      },
      animations: {
        "fade-up": { value: "fade-up 0.45s cubic-bezier(0.22, 1, 0.36, 1) both" },
        "rule-in": { value: "rule-in 0.3s cubic-bezier(0.22, 1, 0.36, 1) both" },
        "meter-fill": { value: "meter-fill 0.6s cubic-bezier(0.22, 1, 0.36, 1) both" },
        spin: { value: "spin 0.8s linear infinite" },
        shimmer: { value: "shimmer 2.2s linear infinite" },
      },
    },
    keyframes: {
      "fade-up": {
        from: { opacity: "0", transform: "translateY(8px)" },
        to: { opacity: "1", transform: "translateY(0)" },
      },
      // Section rules draw in from the left — the Blueline page entrance.
      "rule-in": {
        from: { transform: "scaleX(0)", transformOrigin: "left" },
        to: { transform: "scaleX(1)", transformOrigin: "left" },
      },
      "meter-fill": {
        from: { transform: "scaleX(0)", transformOrigin: "left" },
        to: { transform: "scaleX(1)", transformOrigin: "left" },
      },
      spin: {
        from: { transform: "rotate(0deg)" },
        to: { transform: "rotate(360deg)" },
      },
      shimmer: {
        from: { backgroundPosition: "200% 0" },
        to: { backgroundPosition: "-200% 0" },
      },
    },
    textStyles: {
      display: {
        value: {
          fontFamily: "display",
          fontWeight: "700",
          letterSpacing: "-0.03em",
          lineHeight: "1.05",
        },
      },
      title: {
        value: {
          fontFamily: "display",
          fontWeight: "650",
          letterSpacing: "-0.02em",
          lineHeight: "1.2",
        },
      },
      // Archivo Expanded caps — the width axis is the eyebrow's voice.
      // Expanded is restricted to eyebrows/labels; headings stay normal width.
      eyebrow: {
        value: {
          fontFamily: "display",
          fontStretch: "125%",
          fontWeight: "600",
          fontSize: "11px",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        },
      },
      data: {
        value: {
          fontFamily: "mono",
          fontWeight: "500",
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.01em",
        },
      },
    },
    layerStyles: {
      // True card — reserved for elevation that means something: modals,
      // popovers, menus, pickers, toasts, draggable/selected objects.
      panel: {
        value: {
          bg: "bg.panel",
          borderWidth: "1px",
          borderColor: "border",
          borderRadius: "l3",
          boxShadow: "card",
        },
      },
      panelHover: {
        value: {
          bg: "bg.panel",
          borderWidth: "1px",
          borderColor: "border",
          borderRadius: "l3",
          boxShadow: "card",
          transition:
            "border-color 120ms ease, background 120ms ease, box-shadow 200ms ease",
          _hover: {
            borderColor: "border.emphasized",
            boxShadow: "cardHover",
          },
        },
      },
      // Section band — eyebrow + 1.5px top-rule, no wrapper box.
      band: {
        value: {
          borderTopWidth: "1.5px",
          borderTopColor: "border.strong",
          paddingTop: "4",
        },
      },
      // Well — the only sanctioned container for footage and dense media.
      // bg.subtle in light, graphite in dark; inset hairline; no raw video on white.
      well: {
        value: {
          bg: "bg.subtle",
          borderWidth: "1px",
          borderColor: "border",
          borderRadius: "l2",
          overflow: "hidden",
        },
      },
      // Blueprint grid — fine crosshair grid for ambient zones only
      // (marketing, auth, empty states).
      blueprint: {
        value: {
          backgroundImage: {
            _light:
              "linear-gradient(to right, #E9EAEE 1px, transparent 1px), linear-gradient(to bottom, #E9EAEE 1px, transparent 1px)",
            _dark:
              "linear-gradient(to right, #1B2027 1px, transparent 1px), linear-gradient(to bottom, #1B2027 1px, transparent 1px)",
          },
          backgroundSize: "28px 28px",
        },
      },
    },
    semanticTokens: {
      colors: {
        brand: {
          solid: {
            value: { _light: "{colors.brand.950}", _dark: "{colors.brand.100}" },
          },
          contrast: {
            value: { _light: "{colors.brand.50}", _dark: "{colors.brand.950}" },
          },
          fg: {
            value: { _light: "{colors.brand.950}", _dark: "{colors.brand.200}" },
          },
          muted: {
            value: { _light: "{colors.brand.100}", _dark: "{colors.brand.800}" },
          },
          subtle: {
            value: { _light: "{colors.brand.50}", _dark: "{colors.brand.900}" },
          },
          emphasized: {
            value: { _light: "{colors.brand.300}", _dark: "{colors.brand.700}" },
          },
          focusRing: { value: "{colors.accent.solid}" },
        },
        accent: {
          solid: {
            value: { _light: "{colors.accent.600}", _dark: "#5B6CFF" },
          },
          // Dark label on the dark-mode fill: white on #5B6CFF fails AA (4.17:1);
          // #0E1013 passes (4.57:1). Never white-on-#5B6CFF.
          contrast: {
            value: { _light: "#FFFFFF", _dark: "#0E1013" },
          },
          fg: {
            value: { _light: "{colors.accent.600}", _dark: "#8B97FF" },
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
          focusRing: { value: "{colors.accent.solid}" },
        },
        success: {
          solid: {
            value: { _light: "{colors.success.600}", _dark: "{colors.success.400}" },
          },
          contrast: { value: { _light: "#FFFFFF", _dark: "#0E1013" } },
          fg: {
            value: { _light: "{colors.success.700}", _dark: "{colors.success.400}" },
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
        warning: {
          solid: {
            value: { _light: "{colors.warning.600}", _dark: "{colors.warning.400}" },
          },
          contrast: { value: { _light: "#FFFFFF", _dark: "#0E1013" } },
          fg: {
            value: { _light: "{colors.warning.700}", _dark: "{colors.warning.400}" },
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
        danger: {
          solid: {
            value: { _light: "{colors.danger.600}", _dark: "{colors.danger.500}" },
          },
          contrast: { value: "#FFFFFF" },
          // Dark danger text is lighter than the stripe/solid hex — #E5484D is
          // only 4.42:1 on panel and fails AA for text.
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
        // Backgrounds — porcelain in light, graphite in dark.
        bg: {
          DEFAULT: {
            value: { _light: "#FBFBFC", _dark: "#0E1013" },
          },
          subtle: {
            value: { _light: "#F2F3F5", _dark: "#14171C" },
          },
          muted: {
            value: { _light: "#E9EAEE", _dark: "#1B2027" },
          },
          panel: {
            value: { _light: "#FFFFFF", _dark: "#171B21" },
          },
          accent: {
            value: { _light: "{colors.accent.50}", _dark: "{colors.accent.950}" },
          },
          inverted: {
            value: { _light: "#101318", _dark: "#FBFBFC" },
          },
        },
        fg: {
          DEFAULT: {
            value: { _light: "#101318", _dark: "#E9EBEE" },
          },
          muted: {
            value: { _light: "#585E69", _dark: "#9AA3B0" },
          },
          subtle: {
            value: { _light: "#666C76", _dark: "#828D9C" },
          },
          disabled: {
            value: { _light: "#8F96A0", _dark: "#5E6675" },
          },
          accent: {
            value: { _light: "{colors.accent.600}", _dark: "#8B97FF" },
          },
          // The timecode voice — mono, data-only (timecodes, live durations).
          timecode: {
            value: { _light: "#0B6D7E", _dark: "#7FD4E4" },
          },
          inverted: {
            value: { _light: "#FBFBFC", _dark: "#101318" },
          },
        },
        border: {
          DEFAULT: {
            value: { _light: "#E2E4E9", _dark: "#242A33" },
          },
          subtle: {
            value: { _light: "#EDEEF1", _dark: "#1B2027" },
          },
          emphasized: {
            value: { _light: "#C9CDD4", _dark: "#303845" },
          },
          // Section-rule weight: full ink in light, calm graphite in dark —
          // a near-white rule on graphite reads as glare, not structure.
          strong: {
            value: { _light: "#101318", _dark: "#3E4756" },
          },
          // Perceivable input boundary (WCAG 1.4.11 ≥3:1) — hairlines above
          // are decorative only and never the sole boundary of a control.
          control: {
            value: { _light: "#818893", _dark: "#606B7D" },
          },
          accent: {
            value: { _light: "{colors.accent.300}", _dark: "{colors.accent.700}" },
          },
        },
        // Studio editor chrome — permanently graphite, mode-invariant.
        // Chrome hexes map here; user caption/brand color values stay literal.
        studio: {
          canvas: { value: "#0E1013" },
          // Translucent studio.canvas — the chip/badge ground for overlays
          // sitting on footage (duration chips, delete affordances). rgba()
          // because a semantic token can't derive alpha from another token;
          // the (14,16,19) triplet is studio.canvas (#0E1013) and must be
          // kept in sync with it by hand.
          scrim: { value: "rgba(14, 16, 19, 0.72)" },
          // Hover/pressed step of studio.scrim, for overlay affordances that
          // sit on footage (e.g. delete-project-button.tsx's card variant).
          scrimStrong: { value: "rgba(14, 16, 19, 0.85)" },
          subtle: { value: "#14171C" },
          surface: { value: "#171B21" },
          raised: { value: "#242A33" },
          border: { value: "#242A33" },
          borderStrong: { value: "#303845" },
          // Control-grade boundary for inputs/text wells — >=3:1 against
          // studio.subtle/surface (WCAG 1.4.11); mirrors dark border.control.
          borderControl: { value: "#606B7D" },
          fg: { value: "#E9EBEE" },
          // On studio.raised (#242A33), fgMuted is the minimum text tier;
          // fgSubtle is only legible on canvas/subtle/surface.
          fgMuted: { value: "#9AA3B0" },
          fgSubtle: { value: "#828D9C" },
          accent: { value: "#5B6CFF" },
          accentFg: { value: "#8B97FF" },
          // Danger, mode-invariant — studio chrome never leaves graphite, so
          // the app-wide danger.fg/danger.solid (which flip _light/_dark) are
          // wrong here: light mode's danger.600 #C42B1C is only ~3.2:1 on
          // studio.subtle, below the 4.5:1 AA floor for text. Mirrors what
          // dark surfaces already use — danger.400 for text/icons (6.14:1 on
          // studio.subtle, 5.91:1 on studio.surface; also clears 4.94:1 on
          // studio.raised) — plus danger.500 for borders/fills, which only
          // need the 3:1 non-text floor (WCAG 1.4.11) and clears every studio
          // tier (3.69–4.87:1).
          danger: { value: "#F26D6D" },
          dangerBorder: { value: "#E5484D" },
          timecode: { value: "#7FD4E4" },
          ring: { value: "#5B6CFF" },
        },
      },
    },
    recipes: {
      button: {
        base: {
          fontWeight: "600",
          letterSpacing: "-0.01em",
          borderRadius: "l2",
          transition:
            "background 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 200ms ease",
        },
        variants: {
          variant: {
            outline: {
              borderColor: "border.control",
            },
          },
        },
      },
      heading: {
        base: {
          fontFamily: "display",
          letterSpacing: "-0.02em",
        },
      },
      badge: {
        base: {
          borderRadius: "l1",
          fontWeight: "550",
        },
      },
      input: {
        base: {
          borderRadius: "l2",
          borderColor: "border.control",
        },
      },
      textarea: {
        base: {
          borderRadius: "l2",
          borderColor: "border.control",
        },
      },
    },
  },
})

export const system = createSystem(defaultConfig, config)
