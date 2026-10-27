"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Flex, Text, Stack, Slider, ColorPicker, HStack, Portal, parseColor, Grid } from "@chakra-ui/react";
import { PanelTabs, studioSliderCss } from "./panel-ui";
import { Droplet, Type, AlignCenter, MoveUp, MoveDown, Zap, Smile, Captions, Quote } from "lucide-react";
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

const ANIMATIONS = Object.entries(CAPTION_MOTIONS).map(([id, spec]) => ({
  id: id as CaptionAnimation,
  label: spec.label,
}));

const SHADOWS: { id: CaptionShadow; label: string }[] = [
  { id: "none", label: "None" },
  { id: "soft", label: "Soft" },
  { id: "hard", label: "Hard" },
  { id: "extrude", label: "3D" },
];

type Position = "top" | "center" | "bottom";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="10px">
      {children}
    </Text>
  );
}

function ToggleBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Flex
      as="button"
      aria-pressed={active}
      direction="column"
      align="center"
      justify="center"
      gap="4px"
      w="56px"
      h="48px"
      borderRadius="10px"
      bg={active ? "studio.raised" : "studio.subtle"}
      borderWidth="2px"
      borderColor={active ? "studio.accent" : "transparent"}
      color={active ? "studio.fg" : "studio.fgMuted"}
      cursor="pointer"
      fontSize="11px"
      fontWeight="500"
      onClick={onClick}
      transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
      _hover={{ bg: "studio.raised", color: "studio.fg" }}
    >
      {icon}
      {label}
    </Flex>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <Box>
      <Text fontSize="12px" color="studio.fgMuted" mb="6px">{label}</Text>
      <ColorPicker.Root
        value={parseColor(value)}
        onValueChange={(e) => onChange(e.value.toString("hex"))}
        size="xs"
      >
        <ColorPicker.HiddenInput />
        <ColorPicker.Control>
          <ColorPicker.Trigger
            w="36px"
            h="36px"
            borderRadius="10px"
            borderWidth="0"
            bg="studio.subtle"
            cursor="pointer"
            p="4px"
            aria-label={`${label} color`}
          >
            <ColorPicker.ValueSwatch w="100%" h="100%" borderRadius="l1" />
          </ColorPicker.Trigger>
        </ColorPicker.Control>
        <Portal>
          <ColorPicker.Positioner>
            {/* Portaled — style with mode-invariant studio tokens only */}
            <ColorPicker.Content
              bg="studio.surface"
              borderWidth="1px"
              borderColor="studio.borderStrong"
              borderRadius="l3"
              boxShadow="0 12px 32px rgba(0,0,0,0.6)"
            >
              <ColorPicker.Area />
              <HStack>
                <ColorPicker.EyeDropper size="xs" variant="outline" color="studio.fg" borderColor="studio.borderStrong" />
                <ColorPicker.Sliders />
              </HStack>
            </ColorPicker.Content>
          </ColorPicker.Positioner>
        </Portal>
      </ColorPicker.Root>
    </Box>
  );
}

// ─── Live cue preview ────────────────────────────────────────────────────────
//
// Renders the ACTUAL current caption cue with full preset styling (outline,
// glow, backdrop, highlight box, animation) via the shared caption engine —
// the same renderer the on-video overlay uses.


/** Small pressed-state chip used by the segmented choices below. */
function Chip({
  active,
  onClick,
  children,
  label,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  label?: string;
}) {
  return (
    <Box
      as="button"
      aria-pressed={active}
      aria-label={label}
      px="12px"
      h="32px"
      borderRadius="8px"
      bg={active ? "studio.raised" : "studio.subtle"}
      borderWidth="2px"
      borderColor={active ? "studio.accent" : "transparent"}
      color={active ? "studio.fg" : "studio.fgMuted"}
      cursor="pointer"
      fontSize="12px"
      fontWeight="500"
      whiteSpace="nowrap"
      onClick={onClick}
      transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
      _hover={{ bg: "studio.raised", color: "studio.fg" }}
    >
      {children}
    </Box>
  );
}

function ValueSlider({
  label,
  value,
  min,
  max,
  step,
  format = (value) => String(value),
  onChange,
  coalesceKey,
}: {
  label: string;
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
      <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" minW="28px" textAlign="right">
        {format(value)}
      </Text>
    </Flex>
  );
}

/** Optional colour with an on/off toggle (pill, plate, glow, outer stroke). */
function OptionalColor({
  label,
  toggleLabel,
  value,
  fallback,
  swatch,
  onChange,
}: {
  label: string;
  toggleLabel: string;
  value: string | undefined;
  fallback: string;
  swatch: ReactNode;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Flex gap="6px" align="center">
      <ToggleBtn
        icon={swatch}
        label={value ? toggleLabel : "Off"}
        active={!!value}
        onClick={() => onChange(value ? undefined : fallback)}
      />
      {value && <ColorField label={label} value={value} onChange={onChange} />}
    </Flex>
  );
}

// ─── Live cue preview ────────────────────────────────────────────────────────
//
// Renders the ACTUAL current caption cue with full preset styling via the
// shared caption engine — the same renderer the on-video overlay uses.

function LiveCuePreview() {
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
    <Flex
      ref={stageRef}
      mx="20px"
      mt="16px"
      mb="20px"
      h="112px"
      borderRadius="10px"
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
    <Stack gap="20px" px="20px" pb="16px">
      {CAPTION_PRESET_GROUPS.map((group) => (
        <Box key={group}>
          <SectionLabel>{group}</SectionLabel>
          <Grid templateColumns="repeat(2, minmax(0, 1fr))" columnGap="12px" rowGap="16px">
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

  return (
    <Stack gap="20px" px="20px" py="4px">
      {/* Font */}
      <Box>
        <SectionLabel>Font</SectionLabel>
        <Flex gap="6px" wrap="wrap">
          {CAPTION_FONT_NAMES.map((f) => (
            <Chip key={f} active={!captionPreset.fontAsset && captionPreset.fontName === f} onClick={() => update({ fontName: f, fontAsset: null })}>
              <Text as="span" fontSize="12px" style={captionFontStyle(f)}>
                {f}
              </Text>
            </Chip>
          ))}
        </Flex>
      </Box>

      {/* Motion */}
      <Box>
        <SectionLabel>Animation</SectionLabel>
        <Flex gap="6px" wrap="wrap">
          {ANIMATIONS.map((anim) => (
            <Chip
              key={anim.id}
              active={captionPreset.animation === anim.id}
              onClick={() => update({ animation: anim.id })}
            >
              <Flex as="span" align="center" gap="5px">
                <Zap size={11} />
                {anim.label}
              </Flex>
            </Chip>
          ))}
        </Flex>
      </Box>

      {/* Words per cue */}
      <Box>
        <SectionLabel>Words on screen</SectionLabel>
        <Flex gap="6px">
          {[1, 2, 3, 4, 5].map((count) => (
            <Chip
              key={count}
              label={`${count} word${count === 1 ? "" : "s"} at a time`}
              active={captionPreset.wordsPerCue === count}
              onClick={() => update({ wordsPerCue: count })}
            >
              {count}
            </Chip>
          ))}
        </Flex>
      </Box>

      {/* Display toggles */}
      <Box>
        <SectionLabel>Display</SectionLabel>
        <Flex gap="6px" wrap="wrap">
          <ToggleBtn
            icon={<Type size={14} />}
            label="Outline"
            active={captionPreset.outlineWidth > 0}
            onClick={() => update({ outlineWidth: captionPreset.outlineWidth > 0 ? 0 : 6 })}
          />
          <ToggleBtn
            icon={<Smile size={14} />}
            label="Emoji"
            active={captionPreset.emojis === true}
            onClick={() => update({ emojis: !captionPreset.emojis })}
          />
          <ToggleBtn
            icon={<Captions size={14} />}
            label="Subtitles"
            active={captionPreset.visible !== false}
            onClick={() => update({ visible: captionPreset.visible === false })}
          />
          <ToggleBtn
            icon={<Quote size={14} />}
            label="Punct."
            active={captionPreset.punctuation !== false}
            onClick={() => update({ punctuation: captionPreset.punctuation === false })}
          />
        </Flex>
      </Box>

      {/* Colors — user caption color values, literal by design */}
      <Box>
        <SectionLabel>Colors</SectionLabel>
        <Flex gap="12px">
          <ColorField label="Text" value={captionPreset.primaryColor} onChange={(v) => update({ primaryColor: v })} />
          <ColorField label="Highlight" value={captionPreset.highlightColor} onChange={(v) => update({ highlightColor: v })} />
          <ColorField label="Outline" value={captionPreset.outlineColor} onChange={(v) => update({ outlineColor: v })} />
        </Flex>
      </Box>

      {/* Outline width */}
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

      <BrandFontPicker studio value={captionPreset.fontAsset} onChange={(font) => update({ fontName: "Montserrat", fontAsset: font ? brandFontReference(font) : null })} />

      {/* Font size */}
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

      {/* Text transform */}
      <Box>
        <SectionLabel>Text transform</SectionLabel>
        <Flex gap="6px">
          {(["uppercase", "lowercase", "capitalize", "none"] as const).map((t) => (
            <Chip key={t} active={captionPreset.textTransform === t} onClick={() => update({ textTransform: t })}>
              {t === "none" ? "None" : t === "uppercase" ? "AA" : t === "lowercase" ? "aa" : "Aa"}
            </Chip>
          ))}
        </Flex>
      </Box>

      {/* Position */}
      <Box>
        <SectionLabel>Position</SectionLabel>
        <Flex gap="6px">
          {(["top", "center", "bottom"] as Position[]).map((pos) => {
            const py = captionPreset.positionY ?? CAPTION_POSITION_Y_DEFAULTS[captionPreset.position];
            const px = captionPreset.positionX ?? 50;
            const isActive = Math.abs(px - 50) < 5 && Math.abs(py - CAPTION_POSITION_Y_DEFAULTS[pos]) < 5;

            return (
              <ToggleBtn
                key={pos}
                icon={
                  pos === "top" ? <MoveUp size={14} /> :
                  pos === "center" ? <AlignCenter size={14} /> :
                  <MoveDown size={14} />
                }
                label={pos.charAt(0).toUpperCase() + pos.slice(1)}
                active={isActive}
                onClick={() => update({ position: pos, positionX: undefined, positionY: undefined })}
              />
            );
          })}
        </Flex>
        {captionPreset.positionX !== undefined && (
          <Flex gap="8px" mt="6px" align="center">
            <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted">
              X: {captionPreset.positionX.toFixed(1)}%
            </Text>
            <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted">
              Y: {captionPreset.positionY?.toFixed(1)}%
            </Text>
            <Box
              as="button"
              fontSize="11px"
              color="studio.accentFg"
              cursor="pointer"
              textDecoration="underline"
              textUnderlineOffset="2px"
              onClick={() => update({ positionX: undefined, positionY: undefined })}
            >
              Reset
            </Box>
          </Flex>
        )}
      </Box>

      {/* Shadow */}
      <Box>
        <SectionLabel>Shadow</SectionLabel>
        <Flex gap="6px" align="center">
          {SHADOWS.map((shadow) => (
            <Chip key={shadow.id} active={captionPreset.shadow === shadow.id} onClick={() => update({ shadow: shadow.id })}>
              <Flex as="span" align="center" gap="5px">
                {shadow.id !== "none" && <Droplet size={11} />}
                {shadow.label}
              </Flex>
            </Chip>
          ))}
          {captionPreset.shadow !== "none" && (
            <ColorField label="Color" value={captionPreset.shadowColor} onChange={(v) => update({ shadowColor: v })} />
          )}
        </Flex>
      </Box>

      {/* Second outline */}
      <Box>
        <SectionLabel>Second outline</SectionLabel>
        <OptionalColor
          label="Color"
          toggleLabel="On"
          value={captionPreset.outerOutlineColor}
          fallback="#FFFFFF"
          swatch={<Box w="14px" h="14px" borderRadius="3px" borderWidth="3px" borderColor="studio.fgSubtle" />}
          onChange={(v) =>
            update(v ? { outerOutlineColor: v, outerOutlineWidth: captionPreset.outerOutlineWidth ?? 5 } : { outerOutlineColor: undefined, outerOutlineWidth: undefined })
          }
        />
        {captionPreset.outerOutlineColor && (
          <Box mt="8px">
            <ValueSlider
              label="Second outline width"
              value={captionPreset.outerOutlineWidth ?? 5}
              min={1}
              max={16}
              step={1}
              coalesceKey="caption-outerOutlineWidth"
              onChange={(value, key) => update({ outerOutlineWidth: value }, key)}
            />
          </Box>
        )}
      </Box>

      {/* Backdrop */}
      <Box>
        <SectionLabel>Backdrop</SectionLabel>
        <OptionalColor
          label="Color"
          toggleLabel="On"
          value={captionPreset.backgroundColor}
          fallback="#000000"
          swatch={<Box w="14px" h="14px" bg="studio.fgSubtle" borderRadius="4px" />}
          onChange={(v) =>
            update(v ? { backgroundColor: v, backgroundOpacity: captionPreset.backgroundOpacity ?? 0.6 } : { backgroundColor: undefined, backgroundOpacity: undefined })
          }
        />
        {captionPreset.backgroundColor && (
          <Box mt="8px">
            <ValueSlider
              label="Backdrop opacity"
              value={captionPreset.backgroundOpacity ?? 0.6}
              min={0}
              max={1}
              step={0.05}
              format={(value) => value.toFixed(2)}
              coalesceKey="caption-backgroundOpacity"
              onChange={(value, key) => update({ backgroundOpacity: value }, key)}
            />
          </Box>
        )}
      </Box>

      {/* Highlight pill */}
      <Box>
        <SectionLabel>Highlight pill</SectionLabel>
        <OptionalColor
          label="Color"
          toggleLabel="On"
          value={captionPreset.highlightBoxColor}
          fallback="#6C4DFF"
          swatch={<Box w="14px" h="14px" bg="#6C4DFF" borderRadius="4px" />}
          onChange={(v) =>
            update(v ? { highlightBoxColor: v, highlightBoxOpacity: captionPreset.highlightBoxOpacity ?? 1 } : { highlightBoxColor: undefined, highlightBoxOpacity: undefined })
          }
        />
        {captionPreset.highlightBoxColor && (
          <Box mt="8px">
            <ValueSlider
              label="Highlight pill opacity"
              value={captionPreset.highlightBoxOpacity ?? 1}
              min={0}
              max={1}
              step={0.05}
              format={(value) => value.toFixed(2)}
              coalesceKey="caption-highlightBoxOpacity"
              onChange={(value, key) => update({ highlightBoxOpacity: value }, key)}
            />
          </Box>
        )}
      </Box>

      {/* Glow */}
      <Box>
        <SectionLabel>Glow</SectionLabel>
        <Stack gap="8px">
          <Flex gap="12px" align="flex-end">
            <OptionalColor
              label="All words"
              toggleLabel="All"
              value={captionPreset.glowColor}
              fallback="#FF2BD6"
              swatch={<Box w="14px" h="14px" bg="#FF2BD6" borderRadius="full" boxShadow="0 0 6px #FF2BD6" />}
              onChange={(v) => update({ glowColor: v, glowIntensity: captionPreset.glowIntensity ?? 12 })}
            />
            <OptionalColor
              label="Active word"
              toggleLabel="Active"
              value={captionPreset.highlightGlowColor}
              fallback="#22E4FF"
              swatch={<Box w="14px" h="14px" bg="#22E4FF" borderRadius="full" boxShadow="0 0 6px #22E4FF" />}
              onChange={(v) => update({ highlightGlowColor: v, glowIntensity: captionPreset.glowIntensity ?? 12 })}
            />
          </Flex>
          {(captionPreset.glowColor || captionPreset.highlightGlowColor) && (
            <ValueSlider
              label="Glow intensity"
              value={captionPreset.glowIntensity ?? 12}
              min={0}
              max={20}
              step={1}
              coalesceKey="caption-glowIntensity"
              onChange={(value, key) => update({ glowIntensity: value }, key)}
            />
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

  async function handleApplyToAll() {
    if (applyState === "applying") return;
    setApplyState("applying");
    try {
      const res = await fetch(
        `/api/projects/${clipInfo.projectId}/clips/apply-caption-preset`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // excludeClipId: this session's own clip already has the preset
          // applied locally (it's already `captionPreset` in the open
          // document) and will persist it through the normal
          // revision-guarded autosave — including it here would bump its
          // editorRevision server-side and 409 that autosave.
          body: JSON.stringify({ captionPreset, excludeClipId: clipInfo.id }),
        },
      );
      if (!res.ok) throw new Error("apply failed");
      const { updated } = (await res.json()) as { updated: number };
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
      <LiveCuePreview />

      {activeTab === "presets" && <PresetsGrid />}
      {activeTab === "customize" && <CustomizeControls />}

      {/* Apply to all — secondary action (Export owns the solid button) */}
      <Box px="20px" pb="20px" pt="8px">
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
