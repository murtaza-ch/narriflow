"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Text, Stack, Slider, ColorPicker, HStack, Portal, parseColor, Grid } from "@chakra-ui/react";
import { Bold, Droplet, Type, AlignCenter, MoveUp, MoveDown, Zap, Smile, Captions, Quote } from "lucide-react";
import { useReducedMotion } from "framer-motion";
import { toaster } from "@narriflow/ui";
import { clipAspectRatioOptions } from "@narriflow/validators";
import { useStudio } from "../studio-shell";
import { CaptionCue, resolveCaptionFontFamily, useLiveCaption } from "../caption-style-engine";
import type { CaptionWord } from "../use-current-caption";
import { CAPTION_PRESETS } from "./caption-presets";
import { PresetCard } from "./preset-card";

const FONTS = [
  "Bebas Neue", "Impact", "Arial", "Roboto",
  "Montserrat", "Oswald", "Open Sans",
];

const ANIMATIONS = [
  { id: "none",            label: "None" },
  { id: "word-by-word",    label: "Word by word" },
  { id: "karaoke",         label: "Karaoke" },
  { id: "bounce",          label: "Bounce" },
  { id: "blur-in",         label: "Blur In" },
  { id: "grow",            label: "Grow" },
  { id: "breathe",         label: "Breathe" },
  { id: "soft-landing",    label: "Soft Landing" },
  { id: "glitch",          label: "Glitch" },
  { id: "seamless-bounce", label: "Seamless Bounce" },
];

type Position = "top" | "center" | "bottom";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text textStyle="eyebrow" color="studio.fgMuted" mb="8px">
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
      w="52px"
      h="44px"
      borderRadius="l2"
      bg={active ? "studio.raised" : "studio.subtle"}
      border="1px solid"
      borderColor={active ? "studio.accent" : "studio.border"}
      color={active ? "studio.accentFg" : "studio.fgMuted"}
      cursor="pointer"
      fontSize="10px"
      fontWeight="600"
      onClick={onClick}
      transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
      _hover={{ borderColor: active ? "studio.accent" : "studio.borderStrong", color: active ? "studio.accentFg" : "studio.fg" }}
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
      <Text fontSize="11px" color="studio.fgMuted" mb="5px">{label}</Text>
      <ColorPicker.Root
        value={parseColor(value)}
        onValueChange={(e) => onChange(e.value.toString("hex"))}
        size="xs"
      >
        <ColorPicker.HiddenInput />
        <ColorPicker.Control>
          <ColorPicker.Trigger
            w="32px"
            h="32px"
            borderRadius="l2"
            borderWidth="1px"
            borderColor="studio.borderStrong"
            cursor="pointer"
            p="2px"
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

function LiveCuePreview() {
  const { captionPreset, playbackClock, utterances, clipStartSec, editedTimeMap, aspectRatio } =
    useStudio("captionPreset", "playbackClock", "utterances", "clipStartSec", "editedTimeMap", "aspectRatio");
  const caption = useLiveCaption(playbackClock, utterances, clipStartSec, editedTimeMap);
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
      .slice(0, 3)
      .map((word, i) => ({ word, isActive: i === 1 }));
  }, [utterances]);

  const words = caption?.visibleWords?.length ? caption.visibleWords : fallbackWords;
  // The preview stage is much narrower than the render surface — scale the
  // cue down proportionally, with a floor so text stays legible.
  const scale = stageWidth > 0 ? stageWidth / renderWidth : 0.24;
  const fontSize = Math.max(10, captionPreset.fontSize * scale * 1.6);

  return (
    <Flex
      ref={stageRef}
      mx="12px"
      mb="12px"
      h="88px"
      borderRadius="l2"
      bg="black"
      overflow="hidden"
      position="relative"
      borderWidth="1px"
      borderColor="studio.border"
      align="center"
      justify="center"
      aria-hidden="true"
    >
      <CaptionCue
        preset={captionPreset}
        words={words}
        fontSize={fontSize}
        scale={Math.max(0.3, scale * 1.6)}
        mode="live"
        cueKey={caption?.utteranceIndex ?? "sample"}
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
  const selectedPresetId = useMemo(() => {
    const match = CAPTION_PRESETS.find(
      (p) =>
        p.preset.fontName === captionPreset.fontName &&
        p.preset.animation === captionPreset.animation &&
        p.preset.primaryColor === captionPreset.primaryColor &&
        p.preset.highlightColor === captionPreset.highlightColor,
    );
    return match?.id ?? null;
  }, [captionPreset]);

  const handleSelect = (presetId: string) => {
    const named = CAPTION_PRESETS.find((p) => p.id === presetId);
    if (!named) return;

    // Apply preset but preserve user's position and font size
    setCaptionPreset((prev) => ({
      ...named.preset,
      position: prev.position,
      positionX: prev.positionX,
      positionY: prev.positionY,
      fontSize: prev.fontSize,
    }));
  };

  return (
    <Grid templateColumns="1fr 1fr" gap="8px" px="12px" pb="12px">
      {CAPTION_PRESETS.map((p) => (
        <PresetCard
          key={p.id}
          namedPreset={p}
          isSelected={selectedPresetId === p.id}
          onClick={() => handleSelect(p.id)}
        />
      ))}
    </Grid>
  );
}

// ─── Customize Controls ──────────────────────────────────────────────────────

function CustomizeControls() {
  const { captionPreset, setCaptionPreset, endCoalesce } = useStudio("captionPreset", "setCaptionPreset", "endCoalesce");

  const update = (patch: Partial<typeof captionPreset>, coalesceKey?: string) =>
    setCaptionPreset((p) => ({ ...p, ...patch }), coalesceKey);

  const [localAnimation, setLocalAnimation] = useState(
    captionPreset.animation ?? "word-by-word",
  );

  return (
    <Stack gap="16px" p="12px">
      {/* Font */}
      <Box>
        <SectionLabel>Font</SectionLabel>
        <Box
          overflowX="auto"
          pb="4px"
          css={{
            "&::-webkit-scrollbar": { height: "3px" },
            "&::-webkit-scrollbar-thumb": {
              background: "var(--chakra-colors-studio-raised)",
              borderRadius: "4px",
            },
          }}
        >
          <Flex gap="6px" w="max-content">
            {FONTS.map((f) => {
              const isActive = captionPreset.fontName === f;
              return (
                <Box
                  key={f}
                  as="button"
                  aria-pressed={isActive}
                  px="10px"
                  py="6px"
                  borderRadius="l2"
                  bg={isActive ? "studio.raised" : "studio.subtle"}
                  border="1px solid"
                  borderColor={isActive ? "studio.accent" : "studio.border"}
                  cursor="pointer"
                  onClick={() => update({ fontName: f })}
                  whiteSpace="nowrap"
                  transition="background 120ms ease, border-color 120ms ease"
                  _hover={{ borderColor: isActive ? "studio.accent" : "studio.borderStrong" }}
                >
                  <Text
                    fontSize="12px"
                    color={isActive ? "studio.accentFg" : "studio.fgMuted"}
                    style={{ fontFamily: resolveCaptionFontFamily(f) }}
                  >
                    {f}
                  </Text>
                </Box>
              );
            })}
          </Flex>
        </Box>
      </Box>

      {/* Style toggles */}
      <Box>
        <SectionLabel>Style</SectionLabel>
        <Flex gap="6px" wrap="wrap">
          <ToggleBtn
            icon={<Bold size={14} />}
            label="Bold"
            active={captionPreset.bold}
            onClick={() => update({ bold: !captionPreset.bold })}
          />
          <ToggleBtn
            icon={<Droplet size={14} />}
            label="Shadow"
            active={captionPreset.shadow === 1}
            onClick={() => update({ shadow: captionPreset.shadow ? 0 : 1 })}
          />
          <ToggleBtn
            icon={<Type size={14} />}
            label="Outline"
            active={captionPreset.outlineWidth > 0}
            onClick={() => update({ outlineWidth: captionPreset.outlineWidth > 0 ? 0 : 2 })}
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
            onClick={() =>
              update({ punctuation: captionPreset.punctuation === false })
            }
          />
        </Flex>
      </Box>

      {/* Colors — user caption color values, literal by design */}
      <Box>
        <SectionLabel>Colors</SectionLabel>
        <Flex gap="12px">
          <ColorField
            label="Text"
            value={captionPreset.primaryColor}
            onChange={(v) => update({ primaryColor: v })}
          />
          <ColorField
            label="Highlight"
            value={captionPreset.highlightColor ?? "#00ff88"}
            onChange={(v) => update({ highlightColor: v })}
          />
          <ColorField
            label="Outline"
            value={captionPreset.outlineColor}
            onChange={(v) => update({ outlineColor: v })}
          />
        </Flex>
      </Box>

      {/* Outline width */}
      <Box>
        <SectionLabel>Outline width</SectionLabel>
        <Flex align="center" gap="10px">
          <Slider.Root
            aria-label={["Outline width"]}
            value={[captionPreset.outlineWidth]}
            min={0}
            max={4}
            step={1}
            onValueChange={(e) => update({ outlineWidth: e.value[0]! }, "caption-outlineWidth")}
            onValueChangeEnd={endCoalesce}
            size="sm"
            colorPalette="accent"
            flex="1"
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Text textStyle="data" fontSize="12px" color="studio.fgMuted" w="16px">
            {captionPreset.outlineWidth}
          </Text>
        </Flex>
      </Box>

      {/* Font size */}
      <Box>
        <SectionLabel>Font size</SectionLabel>
        <Flex align="center" gap="10px">
          <Slider.Root
            aria-label={["Font size"]}
            value={[captionPreset.fontSize]}
            min={8}
            max={120}
            step={1}
            onValueChange={(e) => update({ fontSize: e.value[0]! }, "caption-fontSize")}
            onValueChangeEnd={endCoalesce}
            size="sm"
            colorPalette="accent"
            flex="1"
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Text textStyle="data" fontSize="12px" color="studio.fgMuted" w="28px">
            {captionPreset.fontSize}
          </Text>
        </Flex>
      </Box>

      {/* Text transform */}
      <Box>
        <SectionLabel>Text transform</SectionLabel>
        <Flex gap="6px">
          {(["uppercase", "lowercase", "capitalize", "none"] as const).map((t) => {
            const isActive = (captionPreset.textTransform ?? "uppercase") === t;
            return (
              <Box
                key={t}
                as="button"
                aria-pressed={isActive}
                px="8px"
                py="5px"
                borderRadius="l2"
                bg={isActive ? "studio.raised" : "studio.subtle"}
                border="1px solid"
                borderColor={isActive ? "studio.accent" : "studio.border"}
                cursor="pointer"
                onClick={() => update({ textTransform: t })}
                transition="background 120ms ease, border-color 120ms ease"
                _hover={{ borderColor: isActive ? "studio.accent" : "studio.borderStrong" }}
              >
                <Text
                  fontSize="11px"
                  color={isActive ? "studio.accentFg" : "studio.fgMuted"}
                  textTransform="capitalize"
                >
                  {t === "none" ? "None" : t.slice(0, 5)}
                </Text>
              </Box>
            );
          })}
        </Flex>
      </Box>

      {/* Position */}
      <Box>
        <SectionLabel>Position</SectionLabel>
        <Flex gap="6px">
          {(["top", "center", "bottom"] as Position[]).map((pos) => {
            const presetYMap = { top: 10, center: 50, bottom: 88 };
            const py = captionPreset.positionY ?? presetYMap[captionPreset.position];
            const px = captionPreset.positionX ?? 50;
            const isActive = Math.abs(px - 50) < 5 && Math.abs(py - presetYMap[pos]) < 5;

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
                onClick={() => update({
                  position: pos,
                  positionX: 50,
                  positionY: presetYMap[pos],
                })}
              />
            );
          })}
        </Flex>
        {captionPreset.positionX !== undefined && (
          <Flex gap="8px" mt="6px" align="center">
            <Text textStyle="data" fontSize="11px" color="studio.fgMuted">
              X: {captionPreset.positionX.toFixed(1)}%
            </Text>
            <Text textStyle="data" fontSize="11px" color="studio.fgMuted">
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

      {/* Animation */}
      <Box>
        <SectionLabel>Animation</SectionLabel>
        <Stack gap="4px">
          {ANIMATIONS.map((anim) => {
            const isActive = localAnimation === anim.id;
            return (
              <Flex
                key={anim.id}
                as="button"
                aria-pressed={isActive}
                align="center"
                gap="8px"
                px="10px"
                py="8px"
                borderRadius="l2"
                bg={isActive ? "studio.raised" : "transparent"}
                border="1px solid"
                borderColor={isActive ? "studio.accent" : "transparent"}
                cursor="pointer"
                onClick={() => {
                  setLocalAnimation(anim.id as typeof localAnimation);
                  update({ animation: anim.id as typeof localAnimation });
                }}
                transition="background 120ms ease, border-color 120ms ease"
                _hover={{ bg: "studio.subtle" }}
              >
                <Box color={isActive ? "studio.accentFg" : "studio.fgSubtle"}>
                  <Zap size={12} />
                </Box>
                <Text fontSize="12px" color={isActive ? "studio.accentFg" : "studio.fgMuted"}>
                  {anim.label}
                </Text>
              </Flex>
            );
          })}
        </Stack>
      </Box>

      {/* ── Advanced Styling ────────────────────────────────────────────── */}

      {/* Backdrop */}
      <Box>
        <SectionLabel>Backdrop</SectionLabel>
        <Flex gap="6px" align="center" mb="8px">
          <ToggleBtn
            icon={<Box w="14px" h="14px" bg="studio.fgSubtle" borderRadius="2px" />}
            label={captionPreset.backgroundColor ? "On" : "Off"}
            active={!!captionPreset.backgroundColor}
            onClick={() =>
              update(
                captionPreset.backgroundColor
                  ? { backgroundColor: undefined, backgroundOpacity: undefined }
                  : { backgroundColor: "#000000", backgroundOpacity: 0.6 },
              )
            }
          />
          {captionPreset.backgroundColor && (
            <ColorField
              label="Color"
              value={captionPreset.backgroundColor}
              onChange={(v) => update({ backgroundColor: v })}
            />
          )}
        </Flex>
        {captionPreset.backgroundColor && (
          <Flex align="center" gap="10px">
            <Text fontSize="11px" color="studio.fgMuted" w="50px">Opacity</Text>
            <Slider.Root
              aria-label={["Backdrop opacity"]}
              value={[captionPreset.backgroundOpacity ?? 0.6]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(e) => update({ backgroundOpacity: e.value[0]! }, "caption-backgroundOpacity")}
              onValueChangeEnd={endCoalesce}
              size="sm"
              colorPalette="accent"
              flex="1"
            >
              <Slider.Control>
                <Slider.Track>
                  <Slider.Range />
                </Slider.Track>
                <Slider.Thumbs />
              </Slider.Control>
            </Slider.Root>
            <Text textStyle="data" fontSize="11px" color="studio.fgMuted" w="28px">
              {(captionPreset.backgroundOpacity ?? 0.6).toFixed(2)}
            </Text>
          </Flex>
        )}
      </Box>

      {/* Highlight Box */}
      <Box>
        <SectionLabel>Highlight box</SectionLabel>
        <Flex gap="6px" align="center" mb="8px">
          <ToggleBtn
            icon={<Box w="14px" h="14px" bg="#FACC15" borderRadius="2px" />}
            label={captionPreset.highlightBoxColor ? "On" : "Off"}
            active={!!captionPreset.highlightBoxColor}
            onClick={() =>
              update(
                captionPreset.highlightBoxColor
                  ? { highlightBoxColor: undefined, highlightBoxOpacity: undefined }
                  : { highlightBoxColor: "#FACC15", highlightBoxOpacity: 1.0 },
              )
            }
          />
          {captionPreset.highlightBoxColor && (
            <ColorField
              label="Color"
              value={captionPreset.highlightBoxColor}
              onChange={(v) => update({ highlightBoxColor: v })}
            />
          )}
        </Flex>
        {captionPreset.highlightBoxColor && (
          <Flex align="center" gap="10px">
            <Text fontSize="11px" color="studio.fgMuted" w="50px">Opacity</Text>
            <Slider.Root
              aria-label={["Highlight box opacity"]}
              value={[captionPreset.highlightBoxOpacity ?? 1.0]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(e) => update({ highlightBoxOpacity: e.value[0]! }, "caption-highlightBoxOpacity")}
              onValueChangeEnd={endCoalesce}
              size="sm"
              colorPalette="accent"
              flex="1"
            >
              <Slider.Control>
                <Slider.Track>
                  <Slider.Range />
                </Slider.Track>
                <Slider.Thumbs />
              </Slider.Control>
            </Slider.Root>
            <Text textStyle="data" fontSize="11px" color="studio.fgMuted" w="28px">
              {(captionPreset.highlightBoxOpacity ?? 1.0).toFixed(2)}
            </Text>
          </Flex>
        )}
      </Box>

      {/* Glow */}
      <Box>
        <SectionLabel>Glow</SectionLabel>
        <Flex gap="6px" align="center" mb="8px">
          <ToggleBtn
            icon={<Box w="14px" h="14px" bg="#00FFFF" borderRadius="full" boxShadow="0 0 6px #00FFFF" />}
            label={captionPreset.glowColor ? "On" : "Off"}
            active={!!captionPreset.glowColor}
            onClick={() =>
              update(
                captionPreset.glowColor
                  ? { glowColor: undefined, glowIntensity: undefined }
                  : { glowColor: "#00FFFF", glowIntensity: 8 },
              )
            }
          />
          {captionPreset.glowColor && (
            <ColorField
              label="Color"
              value={captionPreset.glowColor}
              onChange={(v) => update({ glowColor: v })}
            />
          )}
        </Flex>
        {captionPreset.glowColor && (
          <Flex align="center" gap="10px">
            <Text fontSize="11px" color="studio.fgMuted" w="50px">Intensity</Text>
            <Slider.Root
              aria-label={["Glow intensity"]}
              value={[captionPreset.glowIntensity ?? 8]}
              min={0}
              max={20}
              step={1}
              onValueChange={(e) => update({ glowIntensity: e.value[0]! }, "caption-glowIntensity")}
              onValueChangeEnd={endCoalesce}
              size="sm"
              colorPalette="accent"
              flex="1"
            >
              <Slider.Control>
                <Slider.Track>
                  <Slider.Range />
                </Slider.Track>
                <Slider.Thumbs />
              </Slider.Control>
            </Slider.Root>
            <Text textStyle="data" fontSize="11px" color="studio.fgMuted" w="20px">
              {captionPreset.glowIntensity ?? 8}
            </Text>
          </Flex>
        )}
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
      <Flex px="12px" pt="12px" gap="4px" mb="12px" role="tablist" aria-label="Caption editing">
        {(["presets", "customize"] as const).map((tab) => {
          const isActive = activeTab === tab;
          return (
            <Flex
              key={tab}
              as="button"
              role="tab"
              aria-selected={isActive}
              align="center"
              px="12px"
              py="6px"
              borderRadius="l2"
              bg={isActive ? "studio.raised" : "transparent"}
              border="1px solid"
              borderColor={isActive ? "studio.borderStrong" : "transparent"}
              color={isActive ? "studio.fg" : "studio.fgMuted"}
              cursor="pointer"
              fontSize="12px"
              fontWeight="500"
              onClick={() => setActiveTab(tab)}
              transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
              textTransform="capitalize"
            >
              {tab}
            </Flex>
          );
        })}
      </Flex>

      {/* Live caption preview — the actual current cue, fully styled */}
      <LiveCuePreview />

      {activeTab === "presets" && <PresetsGrid />}
      {activeTab === "customize" && <CustomizeControls />}

      {/* Apply to all — secondary action (Export owns the solid button) */}
      <Box px="12px" pb="12px" pt="4px">
        <Flex
          as="button"
          w="100%"
          align="center"
          justify="center"
          h="36px"
          borderRadius="l2"
          bg="studio.raised"
          borderWidth="1px"
          borderColor={applyState === "error" ? "danger.solid" : "studio.borderStrong"}
          color={applyState === "error" ? "danger.fg" : "studio.fg"}
          fontSize="13px"
          fontWeight="600"
          cursor={applyState === "applying" ? "default" : "pointer"}
          opacity={applyState === "applying" ? 0.8 : 1}
          transition="background 120ms ease, border-color 120ms ease"
          _hover={applyState === "applying" ? {} : { borderColor: applyState === "error" ? "danger.solid" : "studio.fgSubtle" }}
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
