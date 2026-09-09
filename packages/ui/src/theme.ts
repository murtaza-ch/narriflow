import { createSystem, defaultConfig, defineConfig, defineRecipe, defineSlotRecipe } from "@chakra-ui/react";

/** One size scale for every single-line control. */
const controlSizes = {
  xs: { height: "8", fontSize: "12px", padding: "2.5" },
  sm: { height: "9", fontSize: "13px", padding: "3" },
  md: { height: "10", fontSize: "14px", padding: "3.5" },
  lg: { height: "12", fontSize: "16px", padding: "4" },
} as const;
function controlStyle(size: keyof typeof controlSizes) {
  const value = controlSizes[size];
  return { textStyle: `control${size.toUpperCase()}`, h: value.height, minH: value.height, fontSize: value.fontSize, px: value.padding, "--input-height": `sizes.${value.height}` };
}
const controlVariants = { xs: controlStyle("xs"), sm: controlStyle("sm"), md: controlStyle("md"), lg: controlStyle("lg") };
function buttonStyle(size: keyof typeof controlSizes) {
  const value = controlSizes[size];
  return { h: value.height, minW: value.height, px: value.padding, gap: "2", fontSize: value.fontSize, "--button-height": `sizes.${value.height}` };
}
const buttonSizes = { xs: buttonStyle("xs"), sm: buttonStyle("sm"), md: buttonStyle("md"), lg: buttonStyle("lg") };
const slotControlVariants = (slot: string) => ({ xs: { [slot]: controlVariants.xs }, sm: { [slot]: controlVariants.sm }, md: { [slot]: controlVariants.md }, lg: { [slot]: controlVariants.lg } });

/** Shared dashboard tokens and Chakra component defaults. */
const config = defineConfig({
  globalCss: {
    "html, body": {
      bg: "bg",
      color: "fg",
      scrollBehavior: "smooth",
      fontFeatureSettings: '"ss03", "cv01"',
    },
    "::selection": {
      bg: "accent.muted",
      color: "fg",
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
      background: { _light: "#D4D7DC", _dark: "#383838" },
      borderRadius: "full",
      border: "3px solid transparent",
      backgroundClip: "padding-box",
    },
    "*::-webkit-scrollbar-thumb:hover": {
      background: { _light: "#B8BCC4", _dark: "#454545" },
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
          value: "var(--font-geist-sans), system-ui, sans-serif",
        },
        display: {
          value: "var(--font-geist-sans), system-ui, sans-serif",
        },
        mono: { value: "var(--font-geist-mono), monospace" },
      },
      // Neutral surfaces; footage and user assets provide color.
      colors: {
        brand: {
          50: { value: "#F7F8F9" },
          100: { value: "#F2F3F5" },
          200: { value: "#E2E4E9" },
          300: { value: "#C9CDD4" },
          400: { value: "#AAAAAA" },
          500: { value: "#6E747E" },
          600: { value: "#585E69" },
          700: { value: "#454545" },
          800: { value: "#2A2A2A" },
          900: { value: "#191919" },
          950: { value: "#101010" },
        },
        // Accent scale for selection, links, and focus.
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
        l1: { value: "0.5rem" },
        l2: { value: "0.75rem" },
        l3: { value: "1.25rem" },
      },
      shadows: {
        // Near-none in light — structure is drawn, not lifted. One ambient
        // elevation shadow for true cards (modals, menus, toasts).
        card: {
          value: "0 1px 2px rgba(16, 16, 16, 0.05)",
        },
        cardHover: {
          value: "0 1px 3px rgba(16, 16, 16, 0.06), 0 8px 24px rgba(16, 16, 16, 0.09)",
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
      // Section rules draw in from the left.
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
      controlXS: { value: { fontSize: "12px", lineHeight: "1.25rem" } },
      controlSM: { value: { fontSize: "13px", lineHeight: "1.25rem" } },
      controlMD: { value: { fontSize: "14px", lineHeight: "1.25rem" } },
      controlLG: { value: { fontSize: "16px", lineHeight: "1.5rem" } },
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
          fontWeight: "500",
          letterSpacing: "-0.02em",
          lineHeight: "1.2",
        },
      },
      // Quiet context labels use the same typeface as the rest of the app.
      eyebrow: {
        value: {
          fontFamily: "body",
          fontWeight: "500",
          fontSize: "11px",
          letterSpacing: "0",
          textTransform: "none",
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
          borderRadius: "l3",
          boxShadow: "card",
        },
      },
      panelHover: {
        value: {
          bg: "bg.panel",
          borderRadius: "l3",
          boxShadow: "card",
          transition: "background 120ms ease, box-shadow 200ms ease",
          _hover: {
            boxShadow: "cardHover",
          },
        },
      },
      // Section spacing; each content panel owns its boundary.
      band: {
        value: {
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
              "linear-gradient(to right, #222222 1px, transparent 1px), linear-gradient(to bottom, #222222 1px, transparent 1px)",
          },
          backgroundSize: "28px 28px",
        },
      },
    },
    semanticTokens: {
      radii: { l1: { value: "0.5rem" }, l2: { value: "0.75rem" }, l3: { value: "1.25rem" } },
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
            value: { _light: "{colors.accent.600}", _dark: "#8EAEEC" },
          },
          // A dark label maintains contrast on the pale accent fill.
          contrast: {
            value: { _light: "#FFFFFF", _dark: "#101010" },
          },
          fg: {
            value: { _light: "{colors.accent.600}", _dark: "#A8C3F5" },
          },
          muted: {
            value: { _light: "{colors.accent.100}", _dark: "#293448" },
          },
          subtle: {
            value: { _light: "{colors.accent.50}", _dark: "#1A2332" },
          },
          emphasized: {
            value: { _light: "{colors.accent.200}", _dark: "#3B4F6D" },
          },
          focusRing: { value: "{colors.accent.solid}" },
        },
        success: {
          solid: {
            value: { _light: "{colors.success.600}", _dark: "{colors.success.400}" },
          },
          contrast: { value: { _light: "#FFFFFF", _dark: "#101010" } },
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
          contrast: { value: { _light: "#FFFFFF", _dark: "#101010" } },
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
          sidebar: { value: { _light: "#F7F7F8", _dark: "#080808" } },
          dialog: { value: { _light: "#FFFFFF", _dark: "#0D0D0F" } },
          raised: { value: { _light: "#FFFFFF", _dark: "#252525" } },
          scrim: { value: "rgba(0, 0, 0, 0.8)" },
          DEFAULT: {
            value: { _light: "#FBFBFC", _dark: "#101010" },
          },
          subtle: {
            value: { _light: "#F2F3F5", _dark: "#161616" },
          },
          muted: {
            value: { _light: "#E9EAEE", _dark: "#222222" },
          },
          panel: {
            value: { _light: "#FFFFFF", _dark: "#1B1B1B" },
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
            value: { _light: "#101318", _dark: "#F2F2F2" },
          },
          muted: {
            value: { _light: "#585E69", _dark: "#AAAAAA" },
          },
          subtle: {
            value: { _light: "#666C76", _dark: "#999999" },
          },
          disabled: {
            value: { _light: "#8F96A0", _dark: "#666666" },
          },
          accent: {
            value: { _light: "{colors.accent.600}", _dark: "#A8C3F5" },
          },
          // The timecode voice — mono, data-only (timecodes, live durations).
          timecode: {
            value: { _light: "#0B6D7E", _dark: "#B4BCCB" },
          },
          inverted: {
            value: { _light: "#FBFBFC", _dark: "#101318" },
          },
        },
        border: {
          DEFAULT: {
            value: { _light: "#E2E4E9", _dark: "#2A2A2A" },
          },
          subtle: {
            value: { _light: "#EDEEF1", _dark: "#222222" },
          },
          emphasized: {
            value: { _light: "#C9CDD4", _dark: "#383838" },
          },
          // Section-rule weight: full ink in light, calm graphite in dark —
          // a near-white rule on graphite reads as glare, not structure.
          strong: {
            value: { _light: "#101318", _dark: "#454545" },
          },
          // Perceivable input boundary (WCAG 1.4.11 ≥3:1) — hairlines above
          // are decorative only and never the sole boundary of a control.
          control: {
            value: { _light: "#818893", _dark: "#686868" },
          },
          accent: {
            value: { _light: "{colors.accent.300}", _dark: "{colors.accent.700}" },
          },
        },
        // Studio editor chrome — permanently graphite, mode-invariant.
        // Chrome hexes map here; user caption/brand color values stay literal.
        studio: {
          canvas: { value: "#101010" },
          // Translucent studio.canvas — the chip/badge ground for overlays
          // sitting on footage (duration chips, delete affordances). rgba()
          // because a semantic token can't derive alpha from another token;
          // the (14,16,19) triplet is studio.canvas (#101010) and must be
          // kept in sync with it by hand.
          scrim: { value: "rgba(16, 16, 16, 0.72)" },
          // Hover/pressed step of studio.scrim, for overlay affordances that
          // sit on footage (e.g. delete-project-button.tsx's card variant).
          scrimStrong: { value: "rgba(16, 16, 16, 0.85)" },
          subtle: { value: "#161616" },
          surface: { value: "#191919" },
          raised: { value: "#2A2A2A" },
          border: { value: "#2A2A2A" },
          borderStrong: { value: "#383838" },
          // Control-grade boundary for inputs/text wells — >=3:1 against
          // studio.subtle/surface (WCAG 1.4.11); mirrors dark border.control.
          borderControl: { value: "#686868" },
          fg: { value: "#F2F2F2" },
          // On studio.raised (#2A2A2A), fgMuted is the minimum text tier;
          // fgSubtle is only legible on canvas/subtle/surface.
          fgMuted: { value: "#AAAAAA" },
          fgSubtle: { value: "#999999" },
          accent: { value: "#8EAEEC" },
          accentFg: { value: "#A8C3F5" },
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
          timecode: { value: "#B4BCCB" },
          ring: { value: "#8EAEEC" },
        },
      },
    },
    slotRecipes: {
      field: defineSlotRecipe({
        slots: ["root", "label", "errorText", "helperText", "requiredIndicator"],
        base: { errorText: { color: "danger.fg" }, helperText: { color: "fg.muted" } },
      }),
      nativeSelect: defineSlotRecipe({
        slots: ["root", "field", "indicator"],
        defaultVariants: { size: "sm" },
        variants: { size: slotControlVariants("field") },
        base: { field: { borderRadius: "l2", bg: "bg.subtle", borderColor: "border.emphasized" } },
      }),
      datePicker: defineSlotRecipe({
        slots: ["root", "control", "input", "trigger", "label", "content", "positioner"],
        defaultVariants: { size: "sm" },
        variants: { size: slotControlVariants("input") },
        base: { content: { bg: "bg.panel", color: "fg", borderWidth: "0", borderColor: "border", borderRadius: "xl", boxShadow: "lg", p: "4" }, positioner: { zIndex: "popover" }, input: { borderRadius: "l2", bg: "bg.subtle", borderColor: "border.emphasized", focusRing: "none", _focusVisible: { borderColor: "accent.focusRing", outline: "none", boxShadow: "none" } }, label: { fontSize: "13px", fontWeight: "500", color: "fg.muted" } },
      }),
      checkbox: defineSlotRecipe({
        slots: ["root", "control", "label", "indicator", "group"],
        base: {
          root: { gap: "2", cursor: "pointer", _disabled: { cursor: "not-allowed" } },
          control: { borderRadius: "4px", borderColor: "border.emphasized" },
          label: { fontSize: "sm", fontWeight: "400", color: "fg" },
        },
      }),
      segmentGroup: defineSlotRecipe({
        defaultVariants: { size: "sm" },
        variants: { size: Object.fromEntries(Object.entries(controlSizes).map(([size, value]) => [size, {
          root: { h: value.height, minH: value.height },
          item: { h: "full", minH: "0", px: value.padding, fontSize: value.fontSize, textStyle: `control${size.toUpperCase()}` },
        }])) },
        slots: ["root", "item", "itemText", "itemHiddenInput", "indicator"],
        base: {
          root: {
            bg: "bg.subtle",
            borderWidth: "1px",
            borderColor: "border.emphasized",
            borderRadius: "l2",
            p: "0.5",
          },
          indicator: { bg: "bg.raised", borderRadius: "l1", boxShadow: "none" },
          item: {
            borderRadius: "l1",
            color: "fg.muted",
            fontWeight: "500",
            cursor: "pointer",
            _checked: { color: "fg" },
            _hover: { color: "fg" },
          },
        },
      }),
      numberInput: defineSlotRecipe({
        defaultVariants: { size: "sm" },
        variants: { size: slotControlVariants("input") },
        slots: [
          "root",
          "label",
          "input",
          "control",
          "incrementTrigger",
          "decrementTrigger",
          "scrubber",
        ],
        base: {
          input: {
            bg: "bg.subtle",
            borderColor: "border.emphasized",
            borderRadius: "l2",
            color: "fg",
            fontVariantNumeric: "tabular-nums",
          },
          control: { borderColor: "border.emphasized", borderInlineStartWidth: "1px" },
          incrementTrigger: { color: "fg.muted", _hover: { bg: "bg.muted", color: "fg" } },
          decrementTrigger: { color: "fg.muted", _hover: { bg: "bg.muted", color: "fg" } },
        },
      }),
      select: defineSlotRecipe({
        defaultVariants: { size: "sm" },
        variants: { size: slotControlVariants("trigger") },
        slots: ["root", "trigger", "content", "item", "valueText", "indicator", "label"],
        base: {
          trigger: {
            bg: "bg.subtle",
            borderColor: "border.emphasized",
            borderRadius: "l2",
            fontSize: "sm",
            color: "fg",
            cursor: "pointer",
          },
          content: {
            bg: "bg.raised",
            borderWidth: "1px",
            borderColor: "border.emphasized",
            borderRadius: "l2",
            boxShadow: "0 12px 40px #0006",
          },
          item: {
            fontSize: "sm",
            borderRadius: "l1",
            cursor: "pointer",
            _highlighted: { bg: "bg.muted" },
          },
        },
      }),
      dialog: defineSlotRecipe({
        slots: [
          "backdrop",
          "positioner",
          "content",
          "header",
          "body",
          "footer",
          "title",
          "description",
          "closeTrigger",
        ],
        base: {
          positioner: { p: "4" },
          backdrop: { bg: "bg.scrim", backdropFilter: "blur(8px)" },
          content: {
            bg: "bg.dialog",
            borderWidth: "0",
            borderRadius: "l3",
            boxShadow: "0 24px 80px #0006",
            maxH: "calc(100dvh - 32px)",
          },
          header: { px: "6", pt: "5", pb: "4" },
          title: { fontSize: "md", fontWeight: "500", letterSpacing: "-0.02em" },
          body: { px: "6", pb: "6" },
          footer: { px: "6", pb: "5", gap: "2" },
          closeTrigger: { top: "3", insetEnd: "3", color: "fg.muted" },
        },
        variants: { placement: { center: {} }, scrollBehavior: { inside: {} } },
        defaultVariants: { placement: "center", scrollBehavior: "inside" },
      }),
      drawer: defineSlotRecipe({
        slots: [
          "backdrop",
          "positioner",
          "content",
          "header",
          "body",
          "footer",
          "title",
          "description",
          "closeTrigger",
        ],
        base: {
          backdrop: { bg: "bg.scrim", backdropFilter: "blur(8px)" },
          content: { bg: "bg.dialog", borderWidth: "0", boxShadow: "none" },
          title: { fontSize: "md", fontWeight: "500" },
          header: { px: "6", py: "5" },
          body: { px: "6" },
          footer: { px: "6", py: "5" },
        },
      }),
      card: defineSlotRecipe({
        slots: ["root", "header", "body", "footer", "title", "description"],
        base: {
          root: { borderRadius: "l2", borderWidth: "0", boxShadow: "none" },
          title: { fontWeight: "500", fontSize: "sm" },
        },
        variants: {
          variant: {
            outline: { root: { bg: "bg.panel", borderColor: "border.subtle" } },
            elevated: { root: { bg: "bg.panel", boxShadow: "none" } },
            subtle: { root: { bg: "bg.subtle" } },
          },
        },
        defaultVariants: { variant: "outline" },
      }),
      menu: defineSlotRecipe({
        slots: [
          "content",
          "item",
          "trigger",
          "positioner",
          "itemText",
          "itemIndicator",
          "itemGroup",
          "itemGroupLabel",
          "separator",
          "indicator",
          "arrow",
          "arrowTip",
          "contextTrigger",
          "triggerItem",
        ],
        base: {
          content: {
            bg: "bg.raised",
            borderWidth: "0",
            borderRadius: "l2",
            p: "1.5",
            boxShadow: "0 12px 40px #0006",
          },
          item: {
            borderRadius: "l1",
            fontSize: "sm",
            px: "3",
            py: "2",
            _highlighted: { bg: "bg.muted" },
          },
        },
      }),
      popover: defineSlotRecipe({
        slots: [
          "content",
          "trigger",
          "positioner",
          "header",
          "body",
          "footer",
          "title",
          "description",
          "closeTrigger",
          "arrow",
          "arrowTip",
        ],
        base: {
          content: { bg: "bg.raised", borderRadius: "l2", borderWidth: "0" },
        },
      }),
      tabs: defineSlotRecipe({
        slots: ["root", "list", "trigger", "content", "indicator"],
        base: {
          list: { borderColor: "border.subtle", gap: "4" },
          trigger: {
            fontSize: "sm",
            color: "fg.muted",
            fontWeight: "500",
            px: "1",
            py: "3",
            _selected: { color: "fg" },
          },
        },
      }),
      table: defineSlotRecipe({
        slots: ["root", "header", "body", "row", "cell", "columnHeader", "footer", "caption"],
        base: {
          columnHeader: {
            color: "fg.muted",
            fontWeight: "500",
            textTransform: "none",
            borderColor: "border.subtle",
          },
          cell: { borderColor: "border.subtle", py: "4" },
        },
      }),
    },
    recipes: {
      button: defineRecipe({
        defaultVariants: { size: "sm" },
        base: {
          fontWeight: "500",
          letterSpacing: "-0.01em",
          borderRadius: "l2",
          transition:
            "background 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 200ms ease",
        },
        variants: {
          size: buttonSizes,
          variant: {
            outline: { borderColor: "border.emphasized", bg: "transparent" },
            ghost: { color: "fg.muted", _hover: { bg: "bg.muted", color: "fg" } },
            subtle: { bg: "bg.muted", color: "fg", _hover: { bg: "bg.raised" } },
          },
        },
      }),
      heading: {
        base: {
          fontFamily: "display",
          fontWeight: "500",
          letterSpacing: "-0.02em",
        },
      },
      badge: {
        base: {
          borderRadius: "l1",
          fontWeight: "550",
        },
      },
      input: defineRecipe({
        defaultVariants: { size: "sm" },
        variants: { size: controlVariants },
        base: {
          borderRadius: "l2",
          borderColor: "border.emphasized",
          bg: "bg.subtle",
          _file: {
            bg: "bg.muted",
            color: "fg",
            border: "0",
            borderRadius: "full",
            px: "3",
            py: "1",
            me: "3",
            cursor: "pointer",
            fontSize: "sm",
          },
          _placeholder: { color: "fg.subtle" },
          _focusVisible: { borderColor: "accent.focusRing", outlineColor: "accent.focusRing" },
        },
      }),
      textarea: {
        base: {
          borderRadius: "l2",
          borderColor: "border.emphasized",
          bg: "bg.subtle",
          _placeholder: { color: "fg.subtle" },
          _focusVisible: { borderColor: "accent.focusRing", outlineColor: "accent.focusRing" },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
