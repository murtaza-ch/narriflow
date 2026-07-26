"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Check, Info, RotateCcw } from "lucide-react";
import {
  Button,
  ColorSwatchField,
  PhoneFrame,
  SegmentedControl,
  Select,
  Slider,
  Spinner,
  Switch,
  toaster,
} from "@narriflow/ui";
import {
  CAPTION_CHUNK_SIZE,
  CAPTION_POSITION_Y_DEFAULTS,
  DEFAULT_CAPTION_PRESET,
  emojiForWord,
  type CaptionPreset,
} from "@narriflow/validators";

const FONT_OPTIONS = [
  "Arial",
  "Impact",
  "Roboto",
  "Open Sans",
  "Montserrat",
  "Oswald",
  "Bebas Neue",
];

const ANIMATION_OPTIONS: Array<{
  label: string;
  value: CaptionPreset["animation"];
}> = [
  { label: "None", value: "none" },
  { label: "Word by word", value: "word-by-word" },
  { label: "Karaoke", value: "karaoke" },
  { label: "Bounce", value: "bounce" },
  { label: "Blur in", value: "blur-in" },
  { label: "Grow", value: "grow" },
  { label: "Breathe", value: "breathe" },
  { label: "Soft landing", value: "soft-landing" },
  { label: "Glitch", value: "glitch" },
  { label: "Seamless bounce", value: "seamless-bounce" },
];

const TEXT_TRANSFORM_OPTIONS: Array<{
  label: string;
  value: CaptionPreset["textTransform"];
}> = [
  { label: "None", value: "none" },
  { label: "UPPER", value: "uppercase" },
  { label: "lower", value: "lowercase" },
  { label: "Title", value: "capitalize" },
];

const POSITION_OPTIONS: Array<{
  label: string;
  value: CaptionPreset["position"];
}> = [
  { label: "Bottom", value: "bottom" },
  { label: "Center", value: "center" },
  { label: "Top", value: "top" },
];

// User caption color values are intentionally literal hex (design-language exception).
const TEXT_SWATCHES = ["#FFFFFF", "#000000", "#FFE100", "#00F5FF", "#FF6B6B", "#AAFF00"];
const HIGHLIGHT_SWATCHES = ["#00FF88", "#FFFFFF", "#FFD93D", "#FF00FF", "#7FFF00", "#FF1744"];
const OUTLINE_SWATCHES = ["#000000", "#FFFFFF", "#1A1A2E", "#003300", "#2D1B14", "#4A2040"];

/** The subset of the preset this form edits directly. */
type EditableFields = Pick<
  CaptionPreset,
  | "fontName"
  | "fontSize"
  | "textTransform"
  | "letterSpacing"
  | "bold"
  | "primaryColor"
  | "outlineColor"
  | "outlineWidth"
  | "shadow"
  | "highlightColor"
  | "position"
  | "animation"
>;

function fieldsFrom(preset: CaptionPreset | null | undefined): EditableFields {
  const base = preset ?? DEFAULT_CAPTION_PRESET;
  return {
    fontName: base.fontName ?? DEFAULT_CAPTION_PRESET.fontName,
    fontSize: base.fontSize ?? DEFAULT_CAPTION_PRESET.fontSize,
    textTransform: base.textTransform ?? DEFAULT_CAPTION_PRESET.textTransform,
    letterSpacing: base.letterSpacing ?? DEFAULT_CAPTION_PRESET.letterSpacing,
    bold: base.bold ?? DEFAULT_CAPTION_PRESET.bold,
    primaryColor: base.primaryColor ?? DEFAULT_CAPTION_PRESET.primaryColor,
    outlineColor: base.outlineColor ?? DEFAULT_CAPTION_PRESET.outlineColor,
    outlineWidth: base.outlineWidth ?? DEFAULT_CAPTION_PRESET.outlineWidth,
    shadow: base.shadow ?? DEFAULT_CAPTION_PRESET.shadow,
    highlightColor: base.highlightColor ?? DEFAULT_CAPTION_PRESET.highlightColor,
    position: base.position ?? DEFAULT_CAPTION_PRESET.position,
    animation: base.animation ?? DEFAULT_CAPTION_PRESET.animation,
  };
}

/** PageHeader-style control band: eyebrow above a 1.5px ink rule. */
function ControlBand({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box as="section">
      <Text textStyle="eyebrow" color="fg.subtle" mb="2">
        {title}
      </Text>
      <Box layerStyle="band">
        <Stack gap="5">{children}</Stack>
      </Box>
    </Box>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text fontSize="13px" fontWeight="500" color="fg" mb="1.5">
      {children}
    </Text>
  );
}

export function CaptionPresetForm({
  projectId,
  clipId,
  initialPreset,
}: {
  projectId: string;
  clipId: string;
  initialPreset: CaptionPreset | null | undefined;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [fields, setFields] = useState<EditableFields>(() =>
    fieldsFrom(initialPreset),
  );
  const [savedFields, setSavedFields] = useState<EditableFields>(fields);

  const dirty = useMemo(
    () => JSON.stringify(fields) !== JSON.stringify(savedFields),
    [fields, savedFields],
  );

  function set(patch: Partial<EditableFields>) {
    setFields((current) => ({ ...current, ...patch }));
  }

  // Preserve optional passthrough fields (emojis, positionX/Y, backdrop, glow…)
  // the studio may have written; this form only overrides what it edits.
  const previewPreset = useMemo<CaptionPreset>(
    () => ({ ...(initialPreset ?? {}), ...fields }),
    [initialPreset, fields],
  );

  async function handleSave() {
    setSaving(true);
    const snapshot = fields;

    try {
      const response = await fetch(
        `/api/projects/${projectId}/clips/${clipId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ captionPreset: previewPreset }),
        },
      );

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        toaster.create({
          type: "error",
          title: "Couldn't save preset",
          description: data.error ?? "Something went wrong. Try again.",
        });
        return;
      }

      setSavedFields(snapshot);
      setSaved(true);
      toaster.create({
        type: "success",
        title: "Caption preset saved",
        description: "Applies to new renders of this clip.",
      });
      startTransition(() => {
        router.refresh();
      });
    } catch {
      toaster.create({
        type: "error",
        title: "Couldn't save preset",
        description: "Network error. Check your connection and try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setFields(fieldsFrom(DEFAULT_CAPTION_PRESET));
  }

  const showSavedState = saved && !dirty;

  return (
    <Grid
      templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) 320px" }}
      gap={{ base: "8", lg: "12" }}
      alignItems="start"
    >
      {/* ── Preview (first on mobile, sticky right on desktop) ── */}
      <Box
        order={{ base: 1, lg: 2 }}
        position={{ base: "static", lg: "sticky" }}
        top={{ lg: "8" }}
        justifySelf={{ base: "center", lg: "end" }}
      >
        <Stack gap="3" align="center">
          <PhoneFrame width={{ base: "240px", lg: "300px" }}>
            <CuePreview preset={previewPreset} />
          </PhoneFrame>
          <Text textStyle="data" fontSize="11px" color="fg.subtle">
            9:16 · 1080×1920
          </Text>
          <Flex gap="2" align="flex-start" maxW="300px">
            <Box color="fg.muted" flexShrink={0} mt="1px">
              <Info size={13} aria-hidden />
            </Box>
            <Text fontSize="12px" color="fg.muted">
              Preview uses the shared cue model, so burned-in captions match
              exactly. Changes apply to new renders of this clip.
            </Text>
          </Flex>
        </Stack>
      </Box>

      {/* ── Controls ── */}
      <Stack gap="8" order={{ base: 2, lg: 1 }} minW="0">
        <ControlBand title="Typography">
          <Box w={{ base: "full", sm: "280px" }}>
            <Select
              label="Font"
              size="sm"
              items={FONT_OPTIONS.map((font) => ({ label: font, value: font }))}
              value={fields.fontName}
              onValueChange={(value) => {
                if (value) set({ fontName: value });
              }}
            />
          </Box>
          <Box maxW="320px">
            <Slider
              label="Font size"
              showValueText
              min={8}
              max={120}
              step={1}
              value={fields.fontSize}
              onValueChange={(value) => {
                if (typeof value === "number") set({ fontSize: value });
              }}
            />
          </Box>
          <Box>
            <FieldLabel>Case</FieldLabel>
            <SegmentedControl
              size="sm"
              items={TEXT_TRANSFORM_OPTIONS}
              value={fields.textTransform}
              onValueChange={(value) =>
                set({ textTransform: value as CaptionPreset["textTransform"] })
              }
            />
          </Box>
          <Box maxW="320px">
            <Slider
              label="Letter spacing (em)"
              showValueText
              min={-0.1}
              max={0.5}
              step={0.01}
              value={fields.letterSpacing}
              onValueChange={(value) => {
                if (typeof value === "number") set({ letterSpacing: value });
              }}
            />
          </Box>
          <Switch
            checked={fields.bold}
            onCheckedChange={(checked) => set({ bold: checked })}
          >
            Bold text
          </Switch>
        </ControlBand>

        <ControlBand title="Colors">
          <Flex gap="6" wrap="wrap">
            <ColorSwatchField
              label="Text"
              value={fields.primaryColor}
              onChange={(hex) => set({ primaryColor: hex })}
              swatches={TEXT_SWATCHES}
            />
            <ColorSwatchField
              label="Highlight"
              value={fields.highlightColor}
              onChange={(hex) => set({ highlightColor: hex })}
              swatches={HIGHLIGHT_SWATCHES}
            />
            <ColorSwatchField
              label="Outline"
              value={fields.outlineColor}
              onChange={(hex) => set({ outlineColor: hex })}
              swatches={OUTLINE_SWATCHES}
            />
          </Flex>
          <Box maxW="320px">
            <Slider
              label="Outline width"
              showValueText
              min={0}
              max={4}
              step={1}
              value={fields.outlineWidth}
              onValueChange={(value) => {
                if (typeof value === "number") set({ outlineWidth: value });
              }}
            />
          </Box>
          <Switch
            checked={fields.shadow === 1}
            onCheckedChange={(checked) => set({ shadow: checked ? 1 : 0 })}
          >
            Drop shadow
          </Switch>
        </ControlBand>

        <ControlBand title="Placement">
          <Box>
            <FieldLabel>Position</FieldLabel>
            <SegmentedControl
              size="sm"
              items={POSITION_OPTIONS}
              value={fields.position}
              onValueChange={(value) =>
                set({ position: value as CaptionPreset["position"] })
              }
            />
          </Box>
        </ControlBand>

        <ControlBand title="Animation">
          <Box w={{ base: "full", sm: "280px" }}>
            <Select
              label="Style"
              size="sm"
              items={ANIMATION_OPTIONS}
              value={fields.animation}
              onValueChange={(value) => {
                if (value) set({ animation: value as CaptionPreset["animation"] });
              }}
            />
          </Box>
        </ControlBand>

        <Flex gap="2" align="center" pt="1">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || isPending || !dirty}
          >
            {saving ? (
              <Spinner size="xs" borderColor="transparent" borderTopColor="currentColor" />
            ) : showSavedState ? (
              <Check size={14} aria-hidden />
            ) : null}
            {saving ? "Saving…" : showSavedState ? "Saved" : "Save preset"}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleReset} disabled={saving}>
            <RotateCcw size={14} aria-hidden />
            Reset to defaults
          </Button>
        </Flex>
      </Stack>
    </Grid>
  );
}

// ─── WYSIWYG cue preview ─────────────────────────────────────────────────────

/** Burn-in render width for 9:16 output; preview scales font size against it. */
const RENDER_WIDTH = 1080;

/** One cue's worth of sample words — sized by the shared cue model. */
const SAMPLE_CUE = ["Make", "every", "word", "count"].slice(
  0,
  CAPTION_CHUNK_SIZE,
);

const WORD_CYCLE_MS = 700;

function hexToRgba(hex: string, opacity: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Entrance-animation props per caption animation style. Mirrors the studio
 * overlay's factory so the sample cue previews the same motion the burn-in
 * (and studio) produce.
 */
function getWordMotionProps(
  animation: string,
  isActive: boolean,
  index: number,
): Record<string, unknown> {
  const stagger = index * 0.08;

  switch (animation) {
    case "blur-in":
      return {
        initial: { filter: "blur(10px)", opacity: 0 },
        animate: { filter: "blur(0px)", opacity: 1 },
        transition: { duration: 0.4, ease: "easeOut", delay: stagger },
      };
    case "grow":
      return {
        initial: { scale: 0.2, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { type: "spring", stiffness: 260, damping: 20, delay: stagger },
      };
    case "breathe":
      return isActive
        ? {
            animate: { scale: [1, 1.08, 1] },
            transition: { repeat: Infinity, duration: 1.2, ease: "easeInOut" },
          }
        : {};
    case "soft-landing":
      return {
        initial: { y: -20, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: stagger },
      };
    case "glitch":
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1, x: [0, -3, 4, -2, 0], skewX: [0, -5, 3, -1, 0] },
        transition: { duration: 0.35, delay: stagger },
      };
    case "seamless-bounce":
      return {
        initial: { y: 12, opacity: 0, scale: 0.95 },
        animate: { y: 0, opacity: 1, scale: 1 },
        transition: { type: "spring", stiffness: 300, damping: 15, delay: stagger },
      };
    case "bounce":
      return {
        initial: { y: 10, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        transition: { type: "spring", stiffness: 400, damping: 10, delay: stagger },
      };
    default:
      return {};
  }
}

function CuePreview({ preset }: { preset: CaptionPreset }) {
  const reducedMotion = useReducedMotion();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setFrameWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reducedMotion) return;
    const id = setInterval(() => setTick((t) => t + 1), WORD_CYCLE_MS);
    return () => clearInterval(id);
  }, [reducedMotion]);

  const activeIndex = tick % SAMPLE_CUE.length;
  const cueKey = Math.floor(tick / SAMPLE_CUE.length);

  // Same display scaling the studio overlay uses: raw preset px × frame/1080.
  const displayFontSize =
    frameWidth > 0
      ? preset.fontSize * (frameWidth / RENDER_WIDTH)
      : preset.fontSize * 0.26;

  // Build text-shadow exactly like the studio overlay (outline + shadow + glow).
  const shadowParts: string[] = [];
  if (preset.outlineWidth > 0) {
    for (let x = -preset.outlineWidth; x <= preset.outlineWidth; x++) {
      for (let y = -preset.outlineWidth; y <= preset.outlineWidth; y++) {
        if (x === 0 && y === 0) continue;
        shadowParts.push(`${x}px ${y}px 0 ${preset.outlineColor}`);
      }
    }
  }
  if (preset.shadow) {
    shadowParts.push("0 2px 8px rgba(0,0,0,0.9)");
  }
  if (preset.glowColor) {
    const intensity = preset.glowIntensity ?? 8;
    shadowParts.push(`0 0 ${intensity}px ${preset.glowColor}`);
    shadowParts.push(`0 0 ${intensity * 2}px ${preset.glowColor}40`);
  }
  const textShadow = shadowParts.length > 0 ? shadowParts.join(", ") : undefined;

  const posY = preset.positionY ?? CAPTION_POSITION_Y_DEFAULTS[preset.position];
  const posX = preset.positionX ?? 50;

  const accumulateWords = preset.animation === "word-by-word" && !reducedMotion;
  const visibleCount = accumulateWords ? activeIndex + 1 : SAMPLE_CUE.length;
  const hasBackdrop = Boolean(preset.backgroundColor);
  const hasHighlightBox = Boolean(preset.highlightBoxColor);

  return (
    <Box ref={frameRef} position="absolute" inset="0" aria-hidden>
      <Box
        position="absolute"
        maxW="94%"
        style={{
          top: `${posY}%`,
          left: `${posX}%`,
          transform: "translate(-50%, -50%)",
        }}
      >
        <Box position="relative">
          {hasBackdrop && (
            <Box
              position="absolute"
              inset="-6px -10px"
              borderRadius="6px"
              pointerEvents="none"
              style={{
                backgroundColor: hexToRgba(
                  preset.backgroundColor!,
                  preset.backgroundOpacity ?? 0.6,
                ),
              }}
            />
          )}
          <Flex gap="4px" align="center" justify="center" position="relative" zIndex={1}>
            {SAMPLE_CUE.slice(0, visibleCount).map((word, i) => {
              const isActive = i === activeIndex;
              const motionProps = reducedMotion
                ? {}
                : getWordMotionProps(preset.animation, isActive, i);
              const showBox = hasHighlightBox && isActive;

              return (
                <Box
                  key={`${cueKey}-${preset.animation}-${i}`}
                  position="relative"
                  display="inline-flex"
                >
                  {showBox && (
                    <Box
                      position="absolute"
                      inset="-2px -4px"
                      borderRadius="4px"
                      pointerEvents="none"
                      style={{
                        backgroundColor: hexToRgba(
                          preset.highlightBoxColor!,
                          preset.highlightBoxOpacity ?? 1,
                        ),
                      }}
                    />
                  )}
                  <motion.span
                    {...motionProps}
                    style={{
                      position: "relative",
                      zIndex: 1,
                      fontSize: `${displayFontSize}px`,
                      fontWeight: preset.bold ? 900 : 600,
                      letterSpacing: `${preset.letterSpacing ?? 0.04}em`,
                      color: isActive ? preset.highlightColor : preset.primaryColor,
                      fontFamily: `"${preset.fontName}", Impact, sans-serif`,
                      textShadow,
                      textTransform: (preset.textTransform ??
                        "uppercase") as React.CSSProperties["textTransform"],
                      transition: "color 80ms ease-out",
                      whiteSpace: "nowrap",
                      userSelect: "none",
                      display: "inline-block",
                    }}
                  >
                    {word}
                    {preset.emojis && emojiForWord(word)
                      ? ` ${emojiForWord(word)}`
                      : ""}
                  </motion.span>
                </Box>
              );
            })}
          </Flex>
        </Box>
      </Box>
    </Box>
  );
}
