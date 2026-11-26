"use client";

/**
 * The style controls of a Text Layer (title-text spec section 6): one presentational component, a
 * style in and patches out, shared by the Studio's Text panel (Settings tab), its floating toolbar
 * (the font, size and colour pieces) and the brand kit's title form. It knows nothing of the Studio:
 * the caller turns a patch into a document change and `gesture` into its undo coalescing.
 *
 * Colours here are USER text colours (they are burned in) and stay literal; everything else uses
 * the tone's tokens (Studio graphite by default; the app's surfaces under `TextControlsAppTone`),
 * portaled menus and colour pickers included.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Box, ColorPicker, Flex, HStack, Input, Menu, Portal, Slider, Stack, Text, parseColor } from "@chakra-ui/react";
import { AlignCenter, AlignLeft, AlignRight, Bold, Check, ChevronDown, Italic, Minus, Plus, Underline, UnfoldVertical } from "lucide-react";
import {
  DEFAULT_TEXT_BACKGROUND,
  DEFAULT_TEXT_SHADOW,
  DEFAULT_TEXT_STROKE,
  TEXT_LAYER_FONT_FAMILIES,
  type TextLayerFontFamily,
  type TextLayerStyle,
  resolveTextLayerFace,
} from "@narriflow/validators";
import { captionFontStyle } from "../caption-style-engine";
import { TEXT_LAYER_FONT_SIZE } from "../text-layer-gestures";
import { softFieldProps, studioSliderCss } from "./panel-ui";

/** A style change; `gesture` names a continuous change (a slider or colour drag) to coalesce into one undo step. */
export type TextStyleChange = (patch: Partial<TextLayerStyle>, gesture?: string) => void;

export interface TextStyleControlsProps {
  readonly value: TextLayerStyle;
  readonly onChange: TextStyleChange;
  /** A continuous change ended (slider released, colour picker closed). */
  readonly onGestureEnd?: () => void;
}

/** Sizes the size menu offers (units of min(canvas)/1080); any size in range can be typed. */
export const TEXT_SIZE_CHOICES = [16, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64, 72, 80, 96, 112, 128, 160, 200, 240] as const;
const LINE_SPACING_PCT = { min: 80, max: 250 } as const;

const appFieldFocus = { borderColor: "border.focus", outline: "none", boxShadow: "none" } as const;
/** `softFieldProps` on the app's surfaces. */
const appFieldProps = {
  bg: "bg.soft",
  borderWidth: "1px",
  borderColor: "transparent",
  borderRadius: "10px",
  color: "fg",
  focusVisibleRing: "none",
  _placeholder: { color: "fg.subtle" },
  _focus: appFieldFocus,
  _focusVisible: appFieldFocus,
} as const;
/** The app's own slider (`@narriflow/ui` Slider): a thin muted track, the accent range, a bordered thumb. */
const appSliderCss = {
  "& [data-part=track]": { bg: "bg.muted", h: "3px", borderRadius: "full" },
  "& [data-part=range]": { bg: "accent.solid" },
  "& [data-part=thumb]": { boxSize: "3.5", bg: "bg.panel", borderWidth: "1px", borderColor: "border.control", borderRadius: "full" },
} as const;

/**
 * The tokens the controls draw with. `studio`: the editor's graphite chrome (mode-invariant, so the
 * portaled menus and pickers match it). `app`: the app's own surfaces, light or dark, for the brand
 * kit's title form.
 */
function tone(kind: "studio" | "app") {
  const studio = kind === "studio";
  const t = {
    field: studio ? "studio.subtle" : "bg.soft",
    fieldHover: studio ? "studio.surface" : "bg.softHover",
    hover: studio ? "studio.raised" : "bg.softHover",
    fg: studio ? "studio.fg" : "fg",
    fgMuted: studio ? "studio.fgMuted" : "fg.muted",
    fgSubtle: studio ? "studio.fgSubtle" : "fg.subtle",
    accentFg: studio ? "studio.accentFg" : "accent.fg",
    accentSubtle: studio ? "studio.accentSubtle" : "accent.subtle",
    swatchRing: studio ? "studio.raised" : "bg.softHover",
    pickerTool: studio ? "studio.borderStrong" : "bg.soft",
    /** The colour picker's surface: the raised fill on graphite; on the app's surfaces the theme's dropdown (raised fill, hairline). */
    popover: studio ? { bg: "studio.raised", borderWidth: "0" } : { bg: "bg.raised", borderWidth: "1px", borderColor: "border.card" },
    fieldInput: studio ? softFieldProps : appFieldProps,
    slider: studio ? studioSliderCss : appSliderCss,
  };
  return {
    ...t,
    menuContent: { p: "1", ...(studio ? { bg: "studio.surface", borderWidth: "0" } : t.popover), borderRadius: "12px", boxShadow: "none", color: t.fg },
    menuItem: { gap: "2.5", minH: "36px", px: "2.5", borderRadius: "8px", color: t.fg, bg: "transparent", cursor: "pointer", _hover: { bg: t.hover }, _highlighted: { bg: t.hover } },
    /** A soft control surface (font menu, size, segmented groups). */
    fieldSurface: { bg: t.field, borderRadius: "10px", h: "40px" },
  };
}

const TONES = { studio: tone("studio"), app: tone("app") } as const;
const ToneContext = createContext(TONES.studio);
const useTone = () => useContext(ToneContext);

/** Draws the text controls inside it with the app's own surfaces (light or dark) instead of the Studio's graphite. */
export function TextControlsAppTone({ children }: { children: ReactNode }) {
  return <ToneContext.Provider value={TONES.app}>{children}</ToneContext.Provider>;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** CSS for a family drawn in its own face (its upright `regular` face). */
export function textFamilyFaceStyle(family: TextLayerFontFamily) {
  return captionFontStyle(resolveTextLayerFace({ font: family, bold: false, italic: false }).face);
}

/** The font menu: every family, each written in its own face. */
export function TextFontMenu({ value, onChange, compact = false }: { value: TextLayerFontFamily; onChange: (font: TextLayerFontFamily) => void; compact?: boolean }) {
  const t = useTone();
  return (
    <Menu.Root onSelect={({ value: next }) => onChange(next as TextLayerFontFamily)} positioning={{ placement: "bottom-start" }} lazyMount>
      <Menu.Trigger asChild>
        <Flex
          as="button"
          aria-label={`Font: ${value}`}
          align="center"
          justify="space-between"
          gap="2"
          minW="0"
          px="3"
          {...(compact ? { w: "full", h: "32px", borderRadius: "8px", bg: "transparent", _hover: { bg: t.hover } } : { ...t.fieldSurface, flex: "1", _hover: { bg: t.fieldHover } })}
          color={t.fg}
          fontSize={compact ? "13px" : "14px"}
          cursor="pointer"
          transition="background 120ms ease"
        >
          <Text as="span" truncate style={textFamilyFaceStyle(value)}>
            {value}
          </Text>
          <ChevronDown size={14} />
        </Flex>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content {...t.menuContent} minW="240px" maxH="min(420px, 60vh)" overflowY="auto">
            {TEXT_LAYER_FONT_FAMILIES.map((family) => (
              <Menu.Item key={family} value={family} {...t.menuItem} aria-label={family}>
                <Text as="span" fontSize="16px" style={textFamilyFaceStyle(family)}>
                  {family}
                </Text>
                <Box ms="auto" w="16px" color={t.accentFg}>
                  {family === value ? <Check size={16} /> : null}
                </Box>
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

/** A number field that commits on Enter and blur, and returns to the stored value when what was typed is not a number. */
function NumberField({ label, value, min, max, onCommit, width, suffix, compact = false }: { label: string; value: number; min: number; max: number; onCommit: (value: number) => void; width: string; suffix?: string; compact?: boolean }) {
  const t = useTone();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clamp(Math.round(parsed), min, max);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <Flex align="center" gap="0.5" w={width}>
      <Input
        aria-label={label}
        inputMode="numeric"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
        {...t.fieldInput}
        bg="transparent"
        h={compact ? "32px" : "40px"}
        px="1.5"
        fontSize={compact ? "13px" : "14px"}
        fontVariantNumeric="tabular-nums"
      />
      {suffix ? (
        <Text as="span" fontSize="12px" color={t.fgSubtle} pe="1">
          {suffix}
        </Text>
      ) : null}
    </Flex>
  );
}

/** Font size: typed directly, or picked from the menu. */
export function TextSizeField({ value, onChange, compact = false }: { value: number; onChange: (size: number) => void; compact?: boolean }) {
  const t = useTone();
  return (
    <Flex align="center" {...(compact ? { h: "32px" } : t.fieldSurface)} ps="1" pe="0.5">
      <NumberField label="Font size" value={value} min={TEXT_LAYER_FONT_SIZE.min} max={TEXT_LAYER_FONT_SIZE.max} onCommit={onChange} width={compact ? "40px" : "52px"} compact={compact} />
      <Menu.Root onSelect={({ value: next }) => onChange(Number(next))} positioning={{ placement: "bottom-end" }} lazyMount>
        <Menu.Trigger asChild>
          <Flex as="button" aria-label="Choose a font size" align="center" justify="center" boxSize={compact ? "28px" : "32px"} borderRadius="8px" color={t.fgMuted} cursor="pointer" _hover={{ bg: t.hover, color: t.fg }}>
            <ChevronDown size={14} />
          </Flex>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content {...t.menuContent} minW="96px" maxH="min(320px, 50vh)" overflowY="auto">
              {TEXT_SIZE_CHOICES.map((size) => (
                <Menu.Item key={size} value={String(size)} {...t.menuItem} fontVariantNumeric="tabular-nums" color={size === value ? t.accentFg : t.fg}>
                  {size}
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </Flex>
  );
}

/** A colour swatch that opens a picker. `label` names the colour for assistive tech ("Text colour", "Background colour"). */
export function TextColorSwatch({ label, value, onChange, onGestureEnd, size = "36px" }: { label: string; value: string; onChange: (hex: string) => void; onGestureEnd?: () => void; size?: string }) {
  const t = useTone();
  return (
    <ColorPicker.Root
      value={parseColor(value)}
      onValueChange={(event) => onChange(event.value.toString("hex").toUpperCase())}
      onOpenChange={(event) => {
        if (!event.open) onGestureEnd?.();
      }}
      size="xs"
      lazyMount
    >
      <ColorPicker.HiddenInput />
      <ColorPicker.Control>
        <ColorPicker.Trigger w={size} h={size} borderRadius="full" borderWidth="0" bg={t.swatchRing} cursor="pointer" p="3px" aria-label={label}>
          <ColorPicker.ValueSwatch w="100%" h="100%" borderRadius="full" />
        </ColorPicker.Trigger>
      </ColorPicker.Control>
      <Portal>
        <ColorPicker.Positioner>
          <ColorPicker.Content {...t.popover} borderRadius="12px" boxShadow="none">
            <ColorPicker.Area />
            <HStack>
              <ColorPicker.EyeDropper size="xs" variant="ghost" bg={t.pickerTool} color={t.fg} aria-label={`Pick ${label.toLowerCase()} from the screen`} />
              <ColorPicker.Sliders />
            </HStack>
            <ColorPicker.ChannelInput channel="hex" aria-label={`${label} hex`} {...t.fieldInput} bg={t.field} h="32px" fontSize="13px" />
          </ColorPicker.Content>
        </ColorPicker.Positioner>
      </Portal>
    </ColorPicker.Root>
  );
}

/** One square button of a soft group; `active` is the accent tint. */
function GroupButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  const t = useTone();
  return (
    <Flex
      as="button"
      aria-label={label}
      aria-pressed={active}
      flex="1"
      h="34px"
      minW="34px"
      align="center"
      justify="center"
      borderRadius="8px"
      bg={active ? t.accentSubtle : "transparent"}
      color={active ? t.accentFg : t.fgMuted}
      fontSize="14px"
      fontWeight="600"
      cursor="pointer"
      transition="background 120ms ease, color 120ms ease"
      _hover={active ? undefined : { bg: t.hover, color: t.fg }}
      onClick={onClick}
    >
      {children}
    </Flex>
  );
}

function Group({ label, children, flex }: { label: string; children: ReactNode; flex?: string }) {
  const t = useTone();
  return (
    <Flex role="group" aria-label={label} gap="2px" p="3px" bg={t.field} borderRadius="10px" flex={flex}>
      {children}
    </Flex>
  );
}

const ALIGNMENTS = [
  { value: "left", label: "Align left", icon: <AlignLeft size={16} /> },
  { value: "center", label: "Align centre", icon: <AlignCenter size={16} /> },
  { value: "right", label: "Align right", icon: <AlignRight size={16} /> },
] as const;

/** Alignment as three toggles. */
export function TextAlignGroup({ value, onChange }: { value: TextLayerStyle["align"]; onChange: (align: TextLayerStyle["align"]) => void }) {
  return (
    <Group label="Alignment" flex="1">
      {ALIGNMENTS.map((item) => (
        <GroupButton key={item.value} label={item.label} active={value === item.value} onClick={() => onChange(item.value)}>
          {item.icon}
        </GroupButton>
      ))}
    </Group>
  );
}

/** Case as Aa / AB; the typed text is never rewritten. */
export function TextCaseGroup({ value, onChange }: { value: TextLayerStyle["textCase"]; onChange: (textCase: TextLayerStyle["textCase"]) => void }) {
  return (
    <Group label="Letter case">
      <GroupButton label="As typed" active={value === "none"} onClick={() => onChange("none")}>
        Aa
      </GroupButton>
      <GroupButton label="Uppercase" active={value === "uppercase"} onClick={() => onChange("uppercase")}>
        AB
      </GroupButton>
    </Group>
  );
}

/** A labelled slider with its value. */
function SliderRow({ label, value, min, max, step, format, onChange, onEnd }: { label: string; value: number; min: number; max: number; step: number; format: (value: number) => string; onChange: (value: number) => void; onEnd?: () => void }) {
  const t = useTone();
  return (
    <Flex align="center" gap="3">
      <Text fontSize="12px" color={t.fgMuted} w="64px" flexShrink={0}>
        {label}
      </Text>
      <Slider.Root
        aria-label={[label]}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(event) => onChange(event.value[0] ?? value)}
        onValueChangeEnd={() => onEnd?.()}
        size="sm"
        css={t.slider}
        flex="1"
      >
        <Slider.Control>
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          <Slider.Thumbs />
        </Slider.Control>
      </Slider.Root>
      <Text fontSize="12px" color={t.fg} w="40px" textAlign="right" fontVariantNumeric="tabular-nums">
        {format(value)}
      </Text>
    </Flex>
  );
}

/** An effect row: `+` switches it on with its default, `−` removes it; while on, its controls show under it. */
function EffectRow({ label, on, onAdd, onRemove, swatch, children }: { label: string; on: boolean; onAdd: () => void; onRemove: () => void; swatch?: ReactNode; children?: ReactNode }) {
  const t = useTone();
  return (
    <Box py="3">
      <Flex align="center" gap="3" minH="36px">
        <Text fontSize="14px" color={t.fg} fontWeight="500" flex="1">
          {label}
        </Text>
        {on ? swatch : null}
        <Flex
          as="button"
          aria-label={on ? `Remove ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`}
          boxSize="32px"
          align="center"
          justify="center"
          borderRadius="8px"
          color={t.fgMuted}
          cursor="pointer"
          _hover={{ bg: t.hover, color: t.fg }}
          onClick={on ? onRemove : onAdd}
        >
          {on ? <Minus size={16} /> : <Plus size={16} />}
        </Flex>
      </Flex>
      {on && children ? (
        <Stack gap="2.5" pt="2">
          {children}
        </Stack>
      ) : null}
    </Box>
  );
}

/** A row with a label and a pair of icon choices (Corners, Box display). */
function ChoiceRow<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: readonly { value: T; label: string; icon: ReactNode }[]; onChange: (value: T) => void }) {
  const t = useTone();
  return (
    <Flex align="center" gap="3" py="2.5" minH="36px">
      <Text fontSize="14px" color={t.fg} fontWeight="500" flex="1">
        {label}
      </Text>
      <Group label={label}>
        {items.map((item) => (
          <GroupButton key={item.value} label={item.label} active={value === item.value} onClick={() => onChange(item.value)}>
            {item.icon}
          </GroupButton>
        ))}
      </Group>
    </Flex>
  );
}

/** Rounded and square corner glyphs, line and block box glyphs: drawn, so they read at 16 px. */
const RoundedCorner = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 14V9a6 6 0 0 1 6-6h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
const SquareCorner = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 14V3h11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const LineBoxes = () => (
  <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden="true">
    <rect x="1" y="3" width="16" height="4.5" rx="1.5" fill="currentColor" />
    <rect x="4" y="8.5" width="10" height="4.5" rx="1.5" fill="currentColor" />
  </svg>
);
const BlockBox = () => (
  <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden="true">
    <rect x="1" y="3" width="16" height="10" rx="2" fill="currentColor" />
  </svg>
);

const pct = (value: number) => `${Math.round(value * 100)}%`;
const plain = (value: number) => `${Math.round(value * 10) / 10}`;

/**
 * Every style control of the Settings tab: font, size, alignment, bold / italic / underline, case,
 * line spacing, text colour, and the Shadow, Stroke and Background effects (Corners and Box display
 * only while Background is on).
 */
export function TextStyleControls({ value, onChange, onGestureEnd }: TextStyleControlsProps) {
  const t = useTone();
  const style = value;
  return (
    <Stack gap="2.5">
      <Flex gap="2">
        <TextFontMenu value={style.font} onChange={(font) => onChange({ font })} />
        <TextSizeField value={style.fontSize} onChange={(fontSize) => onChange({ fontSize })} />
      </Flex>
      <Flex gap="2">
        <TextAlignGroup value={style.align} onChange={(align) => onChange({ align })} />
        <Group label="Text emphasis" flex="1">
          <GroupButton label="Bold" active={style.bold} onClick={() => onChange({ bold: !style.bold })}>
            <Bold size={16} />
          </GroupButton>
          <GroupButton label="Italic" active={style.italic} onClick={() => onChange({ italic: !style.italic })}>
            <Italic size={16} />
          </GroupButton>
          <GroupButton label="Underline" active={style.underline} onClick={() => onChange({ underline: !style.underline })}>
            <Underline size={16} />
          </GroupButton>
        </Group>
      </Flex>
      <Flex gap="2" align="center">
        <TextCaseGroup value={style.textCase} onChange={(textCase) => onChange({ textCase })} />
        <Flex align="center" gap="1" ps="2.5" {...t.fieldSurface} title="Line spacing">
          <Box color={t.fgMuted} aria-hidden>
            <UnfoldVertical size={15} />
          </Box>
          <NumberField
            label="Line spacing (percent)"
            value={Math.round(style.lineHeight * 100)}
            min={LINE_SPACING_PCT.min}
            max={LINE_SPACING_PCT.max}
            onCommit={(next) => onChange({ lineHeight: next / 100 })}
            width="64px"
            suffix="%"
          />
        </Flex>
        <Box ms="auto">
          <TextColorSwatch label="Text colour" value={style.color} onChange={(color) => onChange({ color }, "color")} onGestureEnd={onGestureEnd} size="40px" />
        </Box>
      </Flex>

      <Stack gap="0" mt="1">
        <EffectRow
          label="Shadow"
          on={style.shadow !== null}
          onAdd={() => onChange({ shadow: DEFAULT_TEXT_SHADOW })}
          onRemove={() => onChange({ shadow: null })}
          swatch={style.shadow ? <TextColorSwatch label="Shadow colour" value={style.shadow.color} onChange={(color) => onChange({ shadow: { ...style.shadow!, color } }, "shadow-color")} onGestureEnd={onGestureEnd} size="32px" /> : null}
        >
          {style.shadow ? (
            <>
              <SliderRow label="Opacity" value={style.shadow.opacity} min={0} max={1} step={0.05} format={pct} onChange={(opacity) => onChange({ shadow: { ...style.shadow!, opacity } }, "shadow-opacity")} onEnd={onGestureEnd} />
              <SliderRow label="Blur" value={style.shadow.blur} min={0} max={40} step={1} format={plain} onChange={(blur) => onChange({ shadow: { ...style.shadow!, blur } }, "shadow-blur")} onEnd={onGestureEnd} />
              <SliderRow label="Offset X" value={style.shadow.offsetX} min={-60} max={60} step={1} format={plain} onChange={(offsetX) => onChange({ shadow: { ...style.shadow!, offsetX } }, "shadow-x")} onEnd={onGestureEnd} />
              <SliderRow label="Offset Y" value={style.shadow.offsetY} min={-60} max={60} step={1} format={plain} onChange={(offsetY) => onChange({ shadow: { ...style.shadow!, offsetY } }, "shadow-y")} onEnd={onGestureEnd} />
            </>
          ) : null}
        </EffectRow>
        <EffectRow
          label="Stroke"
          on={style.stroke !== null}
          onAdd={() => onChange({ stroke: DEFAULT_TEXT_STROKE })}
          onRemove={() => onChange({ stroke: null })}
          swatch={style.stroke ? <TextColorSwatch label="Stroke colour" value={style.stroke.color} onChange={(color) => onChange({ stroke: { ...style.stroke!, color } }, "stroke-color")} onGestureEnd={onGestureEnd} size="32px" /> : null}
        >
          {style.stroke ? <SliderRow label="Width" value={style.stroke.width} min={0.5} max={16} step={0.5} format={plain} onChange={(width) => onChange({ stroke: { ...style.stroke!, width } }, "stroke-width")} onEnd={onGestureEnd} /> : null}
        </EffectRow>
        <EffectRow
          label="Background"
          on={style.background !== null}
          onAdd={() => onChange({ background: DEFAULT_TEXT_BACKGROUND })}
          onRemove={() => onChange({ background: null })}
          swatch={style.background ? <TextColorSwatch label="Background colour" value={style.background.color} onChange={(color) => onChange({ background: { ...style.background!, color } }, "background-color")} onGestureEnd={onGestureEnd} size="32px" /> : null}
        >
          {style.background ? <SliderRow label="Opacity" value={style.background.opacity} min={0} max={1} step={0.05} format={pct} onChange={(opacity) => onChange({ background: { ...style.background!, opacity } }, "background-opacity")} onEnd={onGestureEnd} /> : null}
        </EffectRow>
        {style.background ? (
          <>
            <ChoiceRow
              label="Corners"
              value={style.background.corners}
              items={[
                { value: "rounded", label: "Rounded corners", icon: <RoundedCorner /> },
                { value: "square", label: "Square corners", icon: <SquareCorner /> },
              ]}
              onChange={(corners) => onChange({ background: { ...style.background!, corners } })}
            />
            <ChoiceRow
              label="Box display"
              value={style.background.display}
              items={[
                { value: "line", label: "One box per line", icon: <LineBoxes /> },
                { value: "block", label: "One box around all lines", icon: <BlockBox /> },
              ]}
              onChange={(display) => onChange({ background: { ...style.background!, display } })}
            />
          </>
        ) : null}
      </Stack>
    </Stack>
  );
}
