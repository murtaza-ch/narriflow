"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Flex, Text, Stack, Slider, ColorPicker, HStack, Portal, parseColor, Grid, VisuallyHidden } from "@chakra-ui/react";
import { PANEL_PX, PanelSegmented, PanelTabs, SectionLabel, chipProps, studioSliderCss } from "./panel-ui";
import { Check, Type, AlignCenter, MoveUp, MoveDown, Smile, Captions, Quote } from "lucide-react";
import { useReducedMotion } from "framer-motion";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  CAPTION_FONT_NAMES,
  CAPTION_MOTIONS,
  CAPTION_POSITION_Y_DEFAULTS,
  CAPTION_PRESET_GROUPS,
  CAPTION_PRESETS,
  applyCaptionPresetLook,
  clipAspectRatioOptions,
  matchCaptionPreset,
  type CaptionAnimation,
  type CaptionPreset,
  type CaptionShadow,
} from "@narriflow/validators";
import { BrandFontPicker, brandFontReference } from "@/app/(app)/brand-kit/_components/brand-fonts";
import { useStudio } from "../studio-shell";
import { CaptionCue, captionFontStyle, useLiveCaption } from "../caption-style-engine";
import type { CaptionWord } from "../use-current-caption";
import { PresetCard } from "./preset-card";
import { createClipsClient, invalidateAfterClipChange } from "@narriflow/api-client/clips";
import { requireStudioApi } from "../studio-api";
import { useStudioApi } from "../use-studio-api";

const ANIMATIONS = Object.entries(CAPTION_MOTIONS).map(([id, spec]) => ({
  id: id as CaptionAnimation,
  label: spec.label,
}));

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
// Renders the ACTUAL current caption cue with full preset styling via the
// shared caption engine — the same renderer the on-video overlay uses.

function LiveCuePreview({ sticky = false }: { sticky?: boolean }) {
  const { captionPreset, playbackClock, utterances, clipStartSec, editedTimeMap, aspectRatio } =
    useStudio("captionPreset", "playbackClock", "utterances", "clipStartSec", "editedTimeMap", "aspectRatio");
  const caption = useLiveCaption(playbackClock, utterances, clipStartSec, captionPreset.wordsPerCue, editedTimeMap);
  const reducedMotion = useReducedMotion() ?? false;

  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(0);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setStageWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const renderWidth =
    clipAspectRatioOptions.find((o) => o.value === aspectRatio)?.width ?? 1080;

  // When playback sits between utterances, fall back to the opening words so
  // the preview always demonstrates the current styling.
  const fallbackWords = useMemo<CaptionWord[]>(() => {
    const text = utterances[0]?.text ?? "Your caption style";
    return text
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, captionPreset.wordsPerCue)
      .map((word, i) => ({ word, isActive: i === Math.min(1, captionPreset.wordsPerCue - 1) }));
  }, [utterances, captionPreset.wordsPerCue]);

  const words = caption?.visibleWords?.length ? caption.visibleWords : fallbackWords;
  // The stage is narrower than the render surface; show the cue at twice the
  // true scale so it stays legible, fitted to the stage like the export.
  const scale = stageWidth > 0 ? (stageWidth / renderWidth) * 2 : 0.5;

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
        <CaptionCue
          preset={captionPreset}
          words={words}
          scale={scale}
          frameWidth={stageWidth}
          cueKey={caption ? `${caption.utteranceIndex}:${caption.cueIndex}` : "sample"}
          cueIndex={caption?.cueIndex ?? 0}
          showEmojis={captionPreset.emojis === true}
          reducedMotion={reducedMotion}
        />
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

function CustomizeControls() {
  const { captionPreset, setCaptionPreset } = useStudio("captionPreset", "setCaptionPreset");

  const update = (patch: Partial<CaptionPreset>, coalesceKey?: string) =>
    setCaptionPreset((p) => ({ ...p, ...patch }), coalesceKey);

  const positionY = captionPreset.positionY ?? CAPTION_POSITION_Y_DEFAULTS[captionPreset.position];
  const positionX = captionPreset.positionX ?? 50;
  const activePosition =
    POSITIONS.find(
      (pos) => Math.abs(positionX - 50) < 5 && Math.abs(positionY - CAPTION_POSITION_Y_DEFAULTS[pos.id]) < 5,
    )?.id ?? "custom";

  return (
    <Stack gap="6" px={PANEL_PX} pt="1" pb="2">
      <Box>
        <SectionLabel>Font</SectionLabel>
        <Flex gap="6px" wrap="wrap">
          {CAPTION_FONT_NAMES.map((f) => (
            <Chip key={f} active={!captionPreset.fontAsset && captionPreset.fontName === f} onClick={() => update({ fontName: f, fontAsset: null })}>
              <Text as="span" fontSize="13px" style={captionFontStyle(f)}>
                {f}
              </Text>
            </Chip>
          ))}
        </Flex>
        <Box mt="4">
          <BrandFontPicker studio value={captionPreset.fontAsset} onChange={(font) => update({ fontName: "Montserrat", fontAsset: font ? brandFontReference(font) : null })} />
        </Box>
      </Box>

      <Box>
        <SectionLabel>Font size</SectionLabel>
        <ValueSlider
          label="Font size"
          value={captionPreset.fontSize}
          min={16}
          max={200}
          step={1}
          coalesceKey="caption-fontSize"
          onChange={(value, key) => update({ fontSize: value }, key)}
        />
      </Box>

      <Box>
        <SectionLabel>Text transform</SectionLabel>
        <PanelSegmented
          ariaLabel="Text transform"
          value={captionPreset.textTransform}
          onChange={(textTransform) => update({ textTransform })}
          items={TEXT_TRANSFORMS}
        />
      </Box>

      <Box>
        <SectionLabel>Animation</SectionLabel>
        <Grid templateColumns="repeat(3, minmax(0, 1fr))" gap="6px">
          {ANIMATIONS.map((anim) => (
            <Chip fill key={anim.id} active={captionPreset.animation === anim.id} onClick={() => update({ animation: anim.id })}>
              {anim.label}
            </Chip>
          ))}
        </Grid>
      </Box>

      <Box>
        <SectionLabel>Words on screen</SectionLabel>
        <PanelSegmented
          ariaLabel="Words on screen"
          value={String(captionPreset.wordsPerCue)}
          onChange={(count) => update({ wordsPerCue: Number(count) })}
          items={[1, 2, 3, 4, 5].map((count) => ({
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

      <Box>
        <SectionLabel>Display</SectionLabel>
        <Grid templateColumns="repeat(2, minmax(0, 1fr))" gap="6px">
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
            </Box>
          )}
        </Stack>
      </Box>
    </Stack>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export function CaptionsPanel() {
  const [activeTab, setActiveTab] = useState<"presets" | "customize">("presets");
  const { captionPreset, clipInfo } = useStudio("captionPreset", "clipInfo");
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
