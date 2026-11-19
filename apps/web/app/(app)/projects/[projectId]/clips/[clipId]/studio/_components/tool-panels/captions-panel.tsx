"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Flex, Text, Stack, Slider, ColorPicker, HStack, Portal, parseColor, Grid, VisuallyHidden } from "@chakra-ui/react";
import { PANEL_PX, PanelSegmented, PanelTabs, SectionLabel, chipProps, studioSliderCss } from "./panel-ui";
import { Check, Type, AlignCenter, MoveUp, MoveDown, Smile, Captions, Quote, ChevronDown, Link2, Unlink2 } from "lucide-react";
import { useReducedMotion } from "framer-motion";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  CAPTION_FONT_NAMES,
  CAPTION_MOTIONS,
  CAPTION_POSITION_Y_DEFAULTS,
  CAPTION_PRESET_GROUPS,
  CAPTION_PRESETS,
  applyCaptionPresetLook,
  captionBlockAnimation,
  captionBlockWordsPerCue,
  captionStyleUsesAccent,
  clipAspectRatioOptions,
  matchCaptionPreset,
  type CaptionAnimation,
  type CaptionDynamicStyle,
  type CaptionPreset,
  type CaptionShadow,
} from "@narriflow/validators";
import { BrandFontPicker, brandFontReference } from "@/app/(app)/brand-kit/_components/brand-fonts";
import { useStudio } from "../studio-shell";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { CaptionCue, captionFontStyle, type CaptionCueWord } from "../caption-style-engine";
import { CaptionBlockFit, staticTimeSource, type CaptionBlockCueInput, type CaptionTimeSource } from "../caption-block-painter";
import { captionActiveWordIndex, captionCueWordsAt, captionLayerAt } from "../caption-cue-at";
import type { PlaybackClock } from "../playback-clock";
import { CAPTION_SAMPLE_LOOP_SEC, CAPTION_SAMPLE_WORDS, captionSampleBlockCue } from "../../../../../../../_shared/caption-sample-cue";
import { PresetCard } from "./preset-card";
import {
  captionEmphasisChanges,
  captionEmphasisFits,
  captionEmphasisRow,
  captionPanelAnimations,
  captionPanelStyle,
  type CaptionEmphasisChip,
  type CaptionEmphasisIntent,
} from "./captions-panel-model";
import { createClipsClient, invalidateAfterClipChange } from "@narriflow/api-client/clips";
import { requireStudioApi } from "../studio-api";
import { useStudioApi } from "../use-studio-api";
import { studioCaptionOmissionNote } from "@/lib/caption-omissions";
import { StudioCaptionOmissionNote } from "./caption-omission-note";

const ANIMATION_LABELS = Object.fromEntries(
  Object.entries(CAPTION_MOTIONS).map(([id, spec]) => [id, spec.label]),
) as Record<CaptionAnimation, string>;

const SHADOWS: { value: CaptionShadow; label: string }[] = [
  { value: "none", label: "None" },
  { value: "soft", label: "Soft" },
  { value: "hard", label: "Hard" },
  { value: "extrude", label: "3D" },
];

const TEXT_TRANSFORMS: { value: CaptionPreset["textTransform"]; label: string }[] = [
  { value: "uppercase", label: "AA" },
  { value: "lowercase", label: "aa" },
  { value: "capitalize", label: "Aa" },
  { value: "none", label: "None" },
];

const POSITIONS = [
  { id: "top", label: "Top", icon: <MoveUp size={14} /> },
  { id: "center", label: "Center", icon: <AlignCenter size={14} /> },
  { id: "bottom", label: "Bottom", icon: <MoveDown size={14} /> },
] as const;

/** Option chip for choices that wrap (fonts, animations); the chosen one takes the accent tint. */
function Chip({
  active,
  onClick,
  children,
  fill = false,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  fill?: boolean;
}) {
  return (
    <Flex
      as="button"
      aria-pressed={active}
      align="center"
      justify="center"
      w={fill ? "100%" : undefined}
      minW="0"
      cursor="pointer"
      whiteSpace="nowrap"
      {...chipProps(active)}
      px={fill ? "8px" : "12px"}
      onClick={onClick}
    >
      {children}
    </Flex>
  );
}

/** On/off display option: icon + label, accent tint and a check while on. */
function ToggleChip({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Flex
      as="button"
      aria-pressed={active}
      align="center"
      gap="8px"
      w="100%"
      cursor="pointer"
      {...chipProps(active)}
      h="36px"
      onClick={onClick}
    >
      {icon}
      <Text as="span" flex="1" textAlign="left" truncate>
        {label}
      </Text>
      {active ? <Check size={13} strokeWidth={2.5} aria-hidden /> : null}
    </Flex>
  );
}

/** Compact switch for an optional effect. */
function EffectSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <Box
      as="button"
      aria-pressed={checked}
      aria-label={label}
      position="relative"
      flexShrink={0}
      w="34px"
      h="20px"
      p="0"
      borderRadius="full"
      border="none"
      bg={checked ? "studio.accent" : "studio.raised"}
      cursor="pointer"
      transition="background 120ms ease"
      onClick={onChange}
    >
      <Box
        position="absolute"
        top="2px"
        left="2px"
        boxSize="16px"
        borderRadius="full"
        bg={checked ? "white" : "studio.fgMuted"}
        transform={checked ? "translateX(14px)" : "none"}
        transition="transform 140ms ease, background 120ms ease"
      />
    </Box>
  );
}

/**
 * A caption colour. The swatch is the user's literal colour; `compact` is the
 * small trigger that sits beside an effect, the default is a labelled tile.
 */
function ColorField({
  label,
  value,
  onChange,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  compact?: boolean;
}) {
  return (
    <Box minW="0">
      <ColorPicker.Root
        value={parseColor(value)}
        onValueChange={(e) => onChange(e.value.toString("hex"))}
        size="xs"
      >
        <ColorPicker.HiddenInput />
        <ColorPicker.Control>
          <ColorPicker.Trigger
            w={compact ? "28px" : "100%"}
            h={compact ? "28px" : "40px"}
            borderRadius={compact ? "8px" : "10px"}
            borderWidth="0"
            bg={compact ? "studio.raised" : "studio.subtle"}
            cursor="pointer"
            p={compact ? "4px" : "5px"}
            aria-label={`${label} color`}
          >
            <ColorPicker.ValueSwatch w="100%" h="100%" borderRadius={compact ? "5px" : "6px"} />
          </ColorPicker.Trigger>
        </ColorPicker.Control>
        <Portal>
          <ColorPicker.Positioner>
            {/* Portaled — style with mode-invariant studio tokens only */}
            <ColorPicker.Content bg="studio.raised" borderWidth="0" borderRadius="12px" boxShadow="none">
              <ColorPicker.Area />
              <HStack>
                <ColorPicker.EyeDropper size="xs" variant="ghost" bg="studio.subtle" color="studio.fg" />
                <ColorPicker.Sliders />
              </HStack>
            </ColorPicker.Content>
          </ColorPicker.Positioner>
        </Portal>
      </ColorPicker.Root>
      {compact ? null : (
        <Text fontSize="12px" color="studio.fgMuted" mt="6px">
          {label}
        </Text>
      )}
    </Box>
  );
}

function ValueSlider({
  label,
  caption,
  value,
  min,
  max,
  step,
  format = (value) => String(value),
  onChange,
  coalesceKey,
}: {
  label: string;
  /** Visible name beside the slider, for sliders nested under an effect. */
  caption?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number, coalesceKey: string) => void;
  coalesceKey: string;
}) {
  const { endCoalesce } = useStudio("endCoalesce");
  return (
    <Flex align="center" gap="10px">
      {caption ? (
        <Text fontSize="12px" color="studio.fgMuted" w="64px" flexShrink={0}>
          {caption}
        </Text>
      ) : null}
      <Slider.Root
        aria-label={[label]}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(e) => onChange(e.value[0]!, coalesceKey)}
        onValueChangeEnd={endCoalesce}
        size="sm"
        css={studioSliderCss}
        flex="1"
      >
        <Slider.Control>
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          <Slider.Thumbs />
        </Slider.Control>
      </Slider.Root>
      <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" minW="32px" textAlign="right">
        {format(value)}
      </Text>
    </Flex>
  );
}

/** One optional effect (second outline, backdrop, pill, glow): name, colour and switch; its controls open while on. */
function EffectRow({
  label,
  value,
  fallback,
  onChange,
  children,
}: {
  label: string;
  value: string | undefined;
  fallback: string;
  onChange: (value: string | undefined) => void;
  children?: ReactNode;
}) {
  return (
    <Box py="6px">
      <Flex align="center" justify="space-between" gap="12px" minH="32px">
        <Text fontSize="13px" color="studio.fg">
          {label}
        </Text>
        <Flex align="center" gap="12px">
          {value ? <ColorField compact label={label} value={value} onChange={onChange} /> : null}
          <EffectSwitch label={label} checked={!!value} onChange={() => onChange(value ? undefined : fallback)} />
        </Flex>
      </Flex>
      {value && children ? (
        <Box pt="6px" pb="2px">
          {children}
        </Box>
      ) : null}
    </Box>
  );
}

// ─── Live cue preview ────────────────────────────────────────────────────────
//
// Renders the ACTUAL current caption cue from the composition plan's caption
// layers (the one cue derivation, the same layers the on-video overlay draws)
// with the shared painters: the classic caption engine, or the block painter
// for a Dynamic Style.

/**
 * The plan's caption layer under the playhead and its active word. State
 * changes only when the cue or (for a classic line) the active word changes;
 * a block cue's poses are painted from the clock by the block painter.
 */
function readLiveCaptionLayer(clock: PlaybackClock, layers: readonly CompositionCaptionVisualLayer[]) {
  const timeSec = clock.getSnapshot();
  const layer = captionLayerAt(layers, timeSec);
  return { layer, activeIndex: layer && !layer.block ? captionActiveWordIndex(layer, timeSec) : -1 };
}

function useLiveCaptionLayer(clock: PlaybackClock, layers: readonly CompositionCaptionVisualLayer[]) {
  const [live, setLive] = useState(() => readLiveCaptionLayer(clock, layers));
  useEffect(() => {
    const update = () => {
      const next = readLiveCaptionLayer(clock, layers);
      setLive((previous) => (previous.layer === next.layer && previous.activeIndex === next.activeIndex ? previous : next));
    };
    update();
    return clock.subscribe(update);
  }, [clock, layers]);
  return live;
}

const PREVIEW_CANVAS_FALLBACK = { width: 1080, height: 1920 } as const;
const SETTLED_SAMPLE = staticTimeSource(CAPTION_SAMPLE_LOOP_SEC - 0.1);

function LiveCuePreview({ sticky = false }: { sticky?: boolean }) {
  const { captionPreset, playbackClock, captionLayers, aspectRatio, clipInfo } =
    useStudio("captionPreset", "playbackClock", "captionLayers", "aspectRatio", "clipInfo");
  const live = useLiveCaptionLayer(playbackClock, captionLayers);
  const reducedMotion = useReducedMotion() ?? false;

  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setStage({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const renderOption = clipAspectRatioOptions.find((o) => o.value === aspectRatio);
  const renderWidth = renderOption?.width ?? 1080;
  const canvas = useMemo(
    () => (renderOption ? { width: renderOption.width, height: renderOption.height } : PREVIEW_CANVAS_FALLBACK),
    [renderOption],
  );
  // The stage is narrower than the render surface; show the cue at twice the
  // true scale so it stays legible, fitted to the stage like the export.
  const scale = stage.width > 0 ? (stage.width / renderWidth) * 2 : 0.5;

  // Between cues the first cue of the clip stands in, settled; with no cues
  // at all (captions hidden, no transcript yet) the style's sample phrase.
  const layer = live.layer ?? captionLayers[0] ?? null;
  const settledAt = useMemo(
    () => (layer && !live.layer ? staticTimeSource(layer.activeRange.endSec - 0.001) : null),
    [layer, live.layer],
  );
  const sampleBlock = useMemo(
    () => (layer ? null : captionSampleBlockCue(captionPreset, { xPct: 50, yPct: 50 }, clipInfo.captionLanguage)),
    [layer, captionPreset, clipInfo.captionLanguage],
  );

  let cue: ReactNode = null;
  if (stage.width > 0) {
    const blockCue = layer?.block ? (layer as CaptionBlockCueInput) : sampleBlock;
    if (blockCue) {
      const timeSource: CaptionTimeSource = layer ? (settledAt ?? playbackClock) : SETTLED_SAMPLE;
      cue = (
        <CaptionBlockFit
          cue={blockCue}
          canvas={layer ? { width: layer.destination.width, height: layer.destination.height } : canvas}
          boxWidth={stage.width}
          boxHeight={stage.height}
          maxScale={scale}
          timeSource={timeSource}
          reducedMotion={reducedMotion}
        />
      );
    } else if (layer) {
      cue = (
        <CaptionCue
          preset={layer.preset}
          words={captionCueWordsAt(layer, live.layer ? playbackClock.getSnapshot() : layer.activeRange.endSec - 0.001)}
          scale={scale}
          frameWidth={stage.width}
          cueKey={layer.id}
          cueIndex={layer.cueIndex}
          showEmojis={layer.preset.emojis === true}
          reducedMotion={reducedMotion}
          preformatted
          language={layer.language}
        />
      );
    } else {
      const words: CaptionCueWord[] = CAPTION_SAMPLE_WORDS.slice(0, captionPreset.wordsPerCue).map((word, index) => ({
        word: word.text,
        isActive: index === Math.min(1, captionPreset.wordsPerCue - 1),
      }));
      cue = (
        <CaptionCue
          preset={captionPreset}
          words={words}
          scale={scale}
          frameWidth={stage.width}
          cueKey="sample"
          showEmojis={captionPreset.emojis === true}
          reducedMotion={reducedMotion}
          language={clipInfo.captionLanguage}
        />
      );
    }
  }

  return (
    // Sticky on Customize so the style stays in view while its controls scroll
    <Box
      position={sticky ? "sticky" : undefined}
      top="0"
      zIndex="2"
      bg="studio.canvas"
      px={PANEL_PX}
      pt="4"
      pb={sticky ? "4" : "5"}
    >
      <Flex
        ref={stageRef}
        h="112px"
        borderRadius="12px"
        overflow="hidden"
        position="relative"
        align="center"
        justify="center"
        aria-hidden="true"
        style={{ background: "radial-gradient(120% 140% at 30% 20%, #2B3242 0%, #12151B 70%)" }}
      >
        {cue}
      </Flex>
    </Box>
  );
}

// ─── Presets Grid ────────────────────────────────────────────────────────────

function PresetsGrid() {
  const { captionPreset, setCaptionPreset } = useStudio("captionPreset", "setCaptionPreset");

  // Derived, not stored: undo/redo/reset change captionPreset without going
  // through handleSelect, so a useState selection silently goes stale.
  const selectedPresetId = useMemo(() => matchCaptionPreset(captionPreset)?.id ?? null, [captionPreset]);

  const handleSelect = (presetId: string) => {
    const named = CAPTION_PRESETS.find((p) => p.id === presetId);
    if (!named) return;
    // A preset sets the whole look (font, size, motion, colours) but keeps
    // where the user placed the captions and their display toggles.
    setCaptionPreset((prev) => applyCaptionPresetLook(prev, named));
  };

  return (
    <Stack gap="6" px={PANEL_PX} pb="4">
      {CAPTION_PRESET_GROUPS.map((group) => (
        <Box key={group}>
          <SectionLabel>{group}</SectionLabel>
          <Grid templateColumns="repeat(2, minmax(0, 1fr))" gap="10px">
            {CAPTION_PRESETS.filter((p) => p.group === group).map((p) => (
              <PresetCard
                key={p.id}
                namedPreset={p}
                isSelected={selectedPresetId === p.id}
                onClick={() => handleSelect(p.id)}
              />
            ))}
          </Grid>
        </Box>
      ))}
    </Stack>
  );
}

// ─── Customize Controls ──────────────────────────────────────────────────────
//
// A classic preset keeps its full control set. A Dynamic Style (spec section 7)
// shows Size, Position, its colours and the Emphasis row, with fonts, motion
// and effects under Advanced; controls a block does not draw (emoji, highlight
// pill, backdrop, active-word glow, second outline) are hidden, never greyed.

function useCaptionUpdate() {
  const { setCaptionPreset } = useStudio("setCaptionPreset");
  return (patch: Partial<CaptionPreset>, coalesceKey?: string) => setCaptionPreset((p) => ({ ...p, ...patch }), coalesceKey);
}

function FontChips({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (font: (typeof CAPTION_FONT_NAMES)[number]) => void;
}) {
  return (
    <Flex gap="6px" wrap="wrap">
      {CAPTION_FONT_NAMES.map((f) => (
        <Chip key={f} active={value === f} onClick={() => onChange(f)}>
          <Text as="span" fontSize="13px" style={captionFontStyle(f)}>
            {f}
          </Text>
        </Chip>
      ))}
    </Flex>
  );
}

function TextFontSection({ label }: { label: string }) {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();
  return (
    <Box>
      <SectionLabel>{label}</SectionLabel>
      <FontChips value={captionPreset.fontAsset ? null : captionPreset.fontName} onChange={(fontName) => update({ fontName, fontAsset: null })} />
      <Box mt="4">
        <BrandFontPicker studio value={captionPreset.fontAsset} onChange={(font) => update({ fontName: "Montserrat", fontAsset: font ? brandFontReference(font) : null })} />
      </Box>
    </Box>
  );
}

function SizeSection({ label }: { label: string }) {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();
  return (
    <Box>
      <SectionLabel>{label}</SectionLabel>
      <ValueSlider
        label={label}
        value={captionPreset.fontSize}
        min={16}
        max={200}
        step={1}
        coalesceKey="caption-fontSize"
        onChange={(value, key) => update({ fontSize: value }, key)}
      />
    </Box>
  );
}

function TextTransformSection() {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();
  return (
    <Box>
      <SectionLabel>Text transform</SectionLabel>
      <PanelSegmented
        ariaLabel="Text transform"
        value={captionPreset.textTransform}
        onChange={(textTransform) => update({ textTransform })}
        items={TEXT_TRANSFORMS}
      />
    </Box>
  );
}

function AnimationSection({ style }: { style: CaptionDynamicStyle | null }) {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();
  const options = captionPanelAnimations(style);
  // A block draws `captionBlockAnimation`: the style's default stands in for a motion it cannot use.
  const current = style ? captionBlockAnimation(captionPreset, style) : captionPreset.animation;
  return (
    <Box>
      <SectionLabel>Animation</SectionLabel>
      <Grid templateColumns="repeat(3, minmax(0, 1fr))" gap="6px">
        {options.map((id) => (
          <Chip fill key={id} active={current === id} onClick={() => update({ animation: id })}>
            {ANIMATION_LABELS[id]}
          </Chip>
        ))}
      </Grid>
    </Box>
  );
}

function WordsOnScreenSection({ dynamic }: { dynamic: boolean }) {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();
  const counts = dynamic ? [2, 3, 4, 5] : [1, 2, 3, 4, 5];
  const value = dynamic ? captionBlockWordsPerCue(captionPreset.wordsPerCue) : captionPreset.wordsPerCue;
  return (
    <Box>
      <SectionLabel>Words on screen</SectionLabel>
      <PanelSegmented
        ariaLabel="Words on screen"
        value={String(value)}
        onChange={(count) => update({ wordsPerCue: Number(count) })}
        items={counts.map((count) => ({
          value: String(count),
          label: (
            <>
              {count}
              <VisuallyHidden>{` word${count === 1 ? "" : "s"} at a time`}</VisuallyHidden>
            </>
          ),
        }))}
      />
    </Box>
  );
}

function PositionSection({ style }: { style: CaptionDynamicStyle | null }) {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();
  // A left-aligned style stores its block's left edge; its default is the style's guide.
  const defaultX = style?.align === "left" ? (style.leftGuidePct ?? 50) : 50;
  const positionY = captionPreset.positionY ?? CAPTION_POSITION_Y_DEFAULTS[captionPreset.position];
  const positionX = captionPreset.positionX ?? defaultX;
  const activePosition =
    POSITIONS.find(
      (pos) => Math.abs(positionX - defaultX) < 5 && Math.abs(positionY - CAPTION_POSITION_Y_DEFAULTS[pos.id]) < 5,
    )?.id ?? "custom";
  return (
    <Box>
      <SectionLabel>Position</SectionLabel>
      <PanelSegmented
        ariaLabel="Caption position"
        value={activePosition}
        onChange={(pos) => {
          if (pos !== "custom") update({ position: pos, positionX: undefined, positionY: undefined });
        }}
        items={POSITIONS.map((pos) => ({
          value: pos.id,
          label: (
            <>
              {pos.icon}
              {pos.label}
            </>
          ),
        }))}
      />
      {captionPreset.positionX !== undefined && (
        <Flex gap="12px" mt="8px" align="center">
          <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted">
            X: {captionPreset.positionX.toFixed(1)}%
          </Text>
          <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted">
            Y: {captionPreset.positionY?.toFixed(1)}%
          </Text>
          <Box
            as="button"
            ml="auto"
            fontSize="12px"
            color="studio.accentFg"
            cursor="pointer"
            onClick={() => update({ positionX: undefined, positionY: undefined })}
          >
            Reset
          </Box>
        </Flex>
      )}
    </Box>
  );
}

function DisplaySection({ dynamic }: { dynamic: boolean }) {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();
  return (
    <Box>
      <SectionLabel>Display</SectionLabel>
      <Grid templateColumns="repeat(2, minmax(0, 1fr))" gap="6px">
        {dynamic ? null : (
          <>
            <ToggleChip
              icon={<Type size={14} />}
              label="Outline"
              active={captionPreset.outlineWidth > 0}
              onClick={() => update({ outlineWidth: captionPreset.outlineWidth > 0 ? 0 : 6 })}
            />
            <ToggleChip
              icon={<Smile size={14} />}
              label="Emoji"
              active={captionPreset.emojis === true}
              onClick={() => update({ emojis: !captionPreset.emojis })}
            />
          </>
        )}
        <ToggleChip
          icon={<Captions size={14} />}
          label="Subtitles"
          active={captionPreset.visible !== false}
          onClick={() => update({ visible: captionPreset.visible === false })}
        />
        <ToggleChip
          icon={<Quote size={14} />}
          label="Punctuation"
          active={captionPreset.punctuation !== false}
          onClick={() => update({ punctuation: captionPreset.punctuation === false })}
        />
      </Grid>
    </Box>
  );
}

function ShadowSection() {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();
  return (
    <Box>
      <SectionLabel
        action={
          captionPreset.shadow !== "none" ? (
            <Box my="-5px">
              <ColorField compact label="Shadow" value={captionPreset.shadowColor} onChange={(v) => update({ shadowColor: v })} />
            </Box>
          ) : null
        }
      >
        Shadow
      </SectionLabel>
      <PanelSegmented ariaLabel="Shadow" value={captionPreset.shadow} onChange={(shadow) => update({ shadow })} items={SHADOWS} />
    </Box>
  );
}

function GlowIntensitySlider() {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();
  return (
    <ValueSlider
      label="Glow intensity"
      caption="Intensity"
      value={captionPreset.glowIntensity ?? 12}
      min={0}
      max={20}
      step={1}
      coalesceKey="caption-glowIntensity"
      onChange={(value, key) => update({ glowIntensity: value }, key)}
    />
  );
}

function ClassicCustomizeControls() {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();

  return (
    <Stack gap="6" px={PANEL_PX} pt="1" pb="2">
      <TextFontSection label="Font" />
      <SizeSection label="Font size" />
      <TextTransformSection />
      <AnimationSection style={null} />
      <WordsOnScreenSection dynamic={false} />
      <PositionSection style={null} />
      <DisplaySection dynamic={false} />

      {/* Colors — user caption color values, literal by design */}
      <Box>
        <SectionLabel>Colors</SectionLabel>
        <Grid templateColumns="repeat(3, minmax(0, 1fr))" gap="10px">
          <ColorField label="Text" value={captionPreset.primaryColor} onChange={(v) => update({ primaryColor: v })} />
          <ColorField label="Highlight" value={captionPreset.highlightColor} onChange={(v) => update({ highlightColor: v })} />
          <ColorField label="Outline" value={captionPreset.outlineColor} onChange={(v) => update({ outlineColor: v })} />
        </Grid>
      </Box>

      <Box>
        <SectionLabel>Outline width</SectionLabel>
        <ValueSlider
          label="Outline width"
          value={captionPreset.outlineWidth}
          min={0}
          max={16}
          step={1}
          coalesceKey="caption-outlineWidth"
          onChange={(value, key) => update({ outlineWidth: value }, key)}
        />
      </Box>

      <ShadowSection />

      <Box>
        <SectionLabel>Effects</SectionLabel>
        <Stack gap="0" px="14px" py="6px" bg="studio.subtle" borderRadius="12px">
          <EffectRow
            label="Second outline"
            value={captionPreset.outerOutlineColor}
            fallback="#FFFFFF"
            onChange={(v) =>
              update(v ? { outerOutlineColor: v, outerOutlineWidth: captionPreset.outerOutlineWidth ?? 5 } : { outerOutlineColor: undefined, outerOutlineWidth: undefined })
            }
          >
            <ValueSlider
              label="Second outline width"
              caption="Width"
              value={captionPreset.outerOutlineWidth ?? 5}
              min={1}
              max={16}
              step={1}
              coalesceKey="caption-outerOutlineWidth"
              onChange={(value, key) => update({ outerOutlineWidth: value }, key)}
            />
          </EffectRow>

          <EffectRow
            label="Backdrop"
            value={captionPreset.backgroundColor}
            fallback="#000000"
            onChange={(v) =>
              update(v ? { backgroundColor: v, backgroundOpacity: captionPreset.backgroundOpacity ?? 0.6 } : { backgroundColor: undefined, backgroundOpacity: undefined })
            }
          >
            <ValueSlider
              label="Backdrop opacity"
              caption="Opacity"
              value={captionPreset.backgroundOpacity ?? 0.6}
              min={0}
              max={1}
              step={0.05}
              format={(value) => value.toFixed(2)}
              coalesceKey="caption-backgroundOpacity"
              onChange={(value, key) => update({ backgroundOpacity: value }, key)}
            />
          </EffectRow>

          <EffectRow
            label="Highlight pill"
            value={captionPreset.highlightBoxColor}
            fallback="#6C4DFF"
            onChange={(v) =>
              update(v ? { highlightBoxColor: v, highlightBoxOpacity: captionPreset.highlightBoxOpacity ?? 1 } : { highlightBoxColor: undefined, highlightBoxOpacity: undefined })
            }
          >
            <ValueSlider
              label="Highlight pill opacity"
              caption="Opacity"
              value={captionPreset.highlightBoxOpacity ?? 1}
              min={0}
              max={1}
              step={0.05}
              format={(value) => value.toFixed(2)}
              coalesceKey="caption-highlightBoxOpacity"
              onChange={(value, key) => update({ highlightBoxOpacity: value }, key)}
            />
          </EffectRow>

          <EffectRow
            label="Glow, all words"
            value={captionPreset.glowColor}
            fallback="#FF2BD6"
            onChange={(v) => update({ glowColor: v, glowIntensity: captionPreset.glowIntensity ?? 12 })}
          />
          <EffectRow
            label="Glow, active word"
            value={captionPreset.highlightGlowColor}
            fallback="#22E4FF"
            onChange={(v) => update({ highlightGlowColor: v, glowIntensity: captionPreset.glowIntensity ?? 12 })}
          />
          {(captionPreset.glowColor || captionPreset.highlightGlowColor) && (
            <Box py="6px">
              <GlowIntensitySlider />
            </Box>
          )}
        </Stack>
      </Box>
    </Stack>
  );
}

/** Advanced disclosure: a soft row that opens the less-used block controls. */
function AdvancedDisclosure({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="6">
      <Flex
        as="button"
        aria-expanded={open}
        align="center"
        justify="space-between"
        h="40px"
        px="3"
        bg="studio.subtle"
        borderRadius="12px"
        color="studio.fg"
        fontSize="13px"
        fontWeight="500"
        cursor="pointer"
        transition="background 120ms ease"
        _hover={{ bg: "studio.surface" }}
        onClick={() => setOpen((value) => !value)}
      >
        Advanced
        <Box color="studio.fgMuted" transform={open ? "rotate(180deg)" : undefined} transition="transform 120ms ease">
          <ChevronDown size={14} />
        </Box>
      </Flex>
      {open ? children : null}
    </Stack>
  );
}

function DynamicCustomizeControls({ style }: { style: CaptionDynamicStyle }) {
  const { captionPreset } = useStudio("captionPreset");
  const update = useCaptionUpdate();
  const usesAccent = captionStyleUsesAccent(style);
  const heroFont = captionPreset.heroFontName ?? style.heroFontName;

  return (
    <Stack gap="6" px={PANEL_PX} pt="1" pb="2">
      <SizeSection label="Size" />
      <PositionSection style={style} />

      {/* Colors — user caption color values, literal by design */}
      <Box>
        <SectionLabel>Colors</SectionLabel>
        <Grid templateColumns={`repeat(${usesAccent ? 3 : 2}, minmax(0, 1fr))`} gap="10px">
          <ColorField label="Text" value={captionPreset.primaryColor} onChange={(v) => update({ primaryColor: v })} />
          <ColorField label="Hero" value={captionPreset.highlightColor} onChange={(v) => update({ highlightColor: v })} />
          {usesAccent ? (
            <ColorField
              label="Accent"
              value={captionPreset.accentColor ?? style.accentColor ?? captionPreset.highlightColor}
              onChange={(v) => update({ accentColor: v })}
            />
          ) : null}
        </Grid>
      </Box>

      <EmphasisSection />
      <DisplaySection dynamic />

      <AdvancedDisclosure>
        <TextFontSection label="Text font" />
        <Box>
          <SectionLabel>Hero font</SectionLabel>
          {/* Built-in faces only (spec 5.2); the style's own face is stored as "unset". */}
          <FontChips value={heroFont} onChange={(f) => update({ heroFontName: f === style.heroFontName ? undefined : f })} />
        </Box>
        <TextTransformSection />
        <AnimationSection style={style} />
        <WordsOnScreenSection dynamic />
        <Box>
          <SectionLabel>Emphasis size</SectionLabel>
          <ValueSlider
            label="Emphasis size"
            value={captionPreset.emphasisScale ?? 1}
            min={0.7}
            max={1.4}
            step={0.05}
            format={(value) => `${value.toFixed(2)}×`}
            coalesceKey="caption-emphasisScale"
            onChange={(value, key) => update({ emphasisScale: Math.abs(value - 1) < 1e-6 ? undefined : value }, key)}
          />
        </Box>
        <ShadowSection />
        <Box>
          <SectionLabel>Effects</SectionLabel>
          <Stack gap="0" px="14px" py="6px" bg="studio.subtle" borderRadius="12px">
            <EffectRow
              label="Outline"
              value={captionPreset.outlineWidth > 0 ? captionPreset.outlineColor : undefined}
              fallback={captionPreset.outlineColor}
              onChange={(v) => update(v ? { outlineColor: v, outlineWidth: captionPreset.outlineWidth > 0 ? captionPreset.outlineWidth : 6 } : { outlineWidth: 0 })}
            >
              <ValueSlider
                label="Outline width"
                caption="Width"
                value={captionPreset.outlineWidth}
                min={1}
                max={16}
                step={1}
                coalesceKey="caption-outlineWidth"
                onChange={(value, key) => update({ outlineWidth: value }, key)}
              />
            </EffectRow>
            <EffectRow
              label="Glow"
              value={captionPreset.glowColor}
              fallback="#FF2BD6"
              onChange={(v) => update({ glowColor: v, glowIntensity: captionPreset.glowIntensity ?? 12 })}
            >
              <GlowIntensitySlider />
            </EffectRow>
          </Stack>
        </Box>
        {/* Curve (styles without tiles, ticket 07) and Hero behind speaker (centre
            stack styles, ticket 09) join here once a renderer draws them. */}
      </AdvancedDisclosure>
    </Stack>
  );
}

function CustomizeControls() {
  const { captionPreset } = useStudio("captionPreset");
  const style = captionPanelStyle(captionPreset);
  return style ? <DynamicCustomizeControls style={style} /> : <ClassicCustomizeControls />;
}

// ─── Emphasis row ────────────────────────────────────────────────────────────

/** The words of the cue under the playhead; tapping one makes it the hero. */
function EmphasisSection() {
  const { playbackClock, captionLayers, studioEdits, setCaptionEmphasis } = useStudio(
    "playbackClock",
    "captionLayers",
    "studioEdits",
    "setCaptionEmphasis",
  );
  const live = useLiveCaptionLayer(playbackClock, captionLayers);
  const overrides = studioEdits.captionEmphasis;
  const layer = live.layer;
  const row = layer ? captionEmphasisRow(layer, overrides) : null;

  const run = (intent: CaptionEmphasisIntent) => {
    if (!layer) return;
    const changes = captionEmphasisChanges(layer, intent);
    if (changes.length === 0) return;
    if (!captionEmphasisFits(overrides, changes)) {
      toaster.create({
        type: "error",
        title: "Too many emphasis changes in this clip",
        description: "Set some captions back to Auto first.",
      });
      return;
    }
    setCaptionEmphasis(changes);
  };

  return (
    <Box>
      <SectionLabel>Emphasis</SectionLabel>
      {row ? (
        <Stack gap="10px">
          <Flex gap="6px" wrap="wrap">
            {row.chips.map((chip) => (
              <EmphasisChip
                key={chip.indices.join("-")}
                chip={chip}
                editable={row.editable}
                join={chip.hero && (row.canJoin || row.joined) ? (row.joined ? "unjoin" : "join") : null}
                onIntent={run}
              />
            ))}
          </Flex>
          {row.editable ? (
            <PanelSegmented
              ariaLabel="Emphasis for this caption"
              size="sm"
              value={row.mode}
              onChange={(mode) => run({ kind: mode === "none" ? "none" : "auto" })}
              items={[
                { value: "auto", label: "Auto" },
                { value: "none", label: "No emphasis" },
              ]}
            />
          ) : (
            <Text fontSize="12px" color="studio.fgMuted">
              Dubbed captions use automatic emphasis.
            </Text>
          )}
        </Stack>
      ) : (
        <Text fontSize="12px" color="studio.fgMuted">
          Move the playhead onto a caption to choose its emphasis.
        </Text>
      )}
    </Box>
  );
}

function EmphasisChip({
  chip,
  editable,
  join,
  onIntent,
}: {
  chip: CaptionEmphasisChip;
  editable: boolean;
  /** The hero chip's Join next toggle: "join" pairs it with the next word, "unjoin" splits the pair. */
  join: "join" | "unjoin" | null;
  onIntent: (intent: CaptionEmphasisIntent) => void;
}) {
  const word = (
    <Flex
      as={editable ? "button" : "span"}
      aria-pressed={editable ? chip.hero : undefined}
      aria-label={editable && !chip.hero ? `Emphasise “${chip.text}”` : undefined}
      align="center"
      minW="0"
      maxW="100%"
      cursor={editable && !chip.hero ? "pointer" : "default"}
      {...chipProps(chip.hero)}
      _hover={editable && !chip.hero ? chipProps(false)._hover : undefined}
      borderEndRadius={join ? "0" : "8px"}
      onClick={editable && !chip.hero ? () => onIntent({ kind: "hero", index: chip.indices[0]! }) : undefined}
    >
      <Text as="span" truncate>
        {chip.text}
      </Text>
    </Flex>
  );
  if (!editable || !join) return word;
  const label = join === "join" ? "Join next word" : "Split the joined words";
  return (
    <Flex minW="0" maxW="100%" gap="1px">
      {word}
      <Flex
        as="button"
        aria-label={label}
        aria-pressed={join === "unjoin"}
        title={label}
        align="center"
        justify="center"
        flexShrink={0}
        cursor="pointer"
        {...chipProps(true)}
        px="8px"
        borderStartRadius="0"
        onClick={() => onIntent({ kind: join })}
      >
        {join === "join" ? <Link2 size={14} aria-hidden /> : <Unlink2 size={14} aria-hidden />}
      </Flex>
    </Flex>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export function CaptionsPanel() {
  const [activeTab, setActiveTab] = useState<"presets" | "customize">("presets");
  const { captionPreset, clipInfo, editorDocument } = useStudio("captionPreset", "clipInfo", "editorDocument");
  const omissionNote = useMemo(() => studioCaptionOmissionNote(editorDocument), [editorDocument]);
  const [applyState, setApplyState] = useState<
    "idle" | "applying" | "applied" | "error"
  >("idle");
  const studioApi = useStudioApi();

  async function handleApplyToAll() {
    if (applyState === "applying") return;
    setApplyState("applying");
    try {
      const api = requireStudioApi(studioApi);
      // excludeClipId: this session's own clip already has the preset
      // applied locally (it's already `captionPreset` in the open
      // document) and will persist it through the normal
      // revision-guarded autosave — including it here would bump its
      // editorRevision server-side and 409 that autosave.
      const response = await createClipsClient(api.runtime.transport.scoped(api.scope)).projects[":id"].clips[
        "apply-caption-preset"
      ].$post({
        param: { id: clipInfo.projectId },
        json: { captionPreset, excludeClipId: clipInfo.id },
      });
      const { updated } = (await response.json()) as { updated: number };
      void invalidateAfterClipChange(api.runtime.queryClient, api.scope, clipInfo.projectId);
      setApplyState("applied");
      toaster.create({
        type: "success",
        title:
          updated > 0
            ? `Applied to ${updated} other clip${updated === 1 ? "" : "s"}`
            : "Every other clip already matches",
      });
      setTimeout(() => setApplyState("idle"), 2000);
    } catch {
      setApplyState("error");
      toaster.create({
        type: "error",
        title: "Couldn't apply to all clips",
        description: "The caption style wasn't applied. Try again.",
      });
      setTimeout(() => setApplyState("idle"), 3000);
    }
  }

  return (
    <Stack gap="0">
      {/* Tabs */}
      <PanelTabs
        ariaLabel="Caption editing"
        items={[
          { id: "presets", label: "Presets" },
          { id: "customize", label: "Customize" },
        ]}
        value={activeTab}
        onChange={setActiveTab}
      />

      {/* Live caption preview — the actual current cue, fully styled */}
      <LiveCuePreview sticky={activeTab === "customize"} />
      <StudioCaptionOmissionNote note={omissionNote} />

      {activeTab === "presets" && <PresetsGrid />}
      {activeTab === "customize" && <CustomizeControls />}

      {/* Apply to all — secondary action (Export owns the solid button) */}
      <Box px={PANEL_PX} pb="5" pt="2">
        <Flex
          as="button"
          w="100%"
          align="center"
          justify="center"
          h="44px"
          borderRadius="10px"
          bg="studio.raised"
          border="none"
          color={applyState === "error" ? "studio.danger" : "studio.fg"}
          fontSize="14px"
          fontWeight="500"
          cursor={applyState === "applying" ? "default" : "pointer"}
          opacity={applyState === "applying" ? 0.8 : 1}
          transition="background 120ms ease"
          _hover={applyState === "applying" ? {} : { bg: "studio.borderStrong" }}
          onClick={handleApplyToAll}
        >
          {applyState === "applying"
            ? "Applying…"
            : applyState === "applied"
              ? "Applied to all clips ✓"
              : applyState === "error"
                ? "Failed — try again"
                : "Apply to all clips"}
        </Flex>
      </Box>
    </Stack>
  );
}
