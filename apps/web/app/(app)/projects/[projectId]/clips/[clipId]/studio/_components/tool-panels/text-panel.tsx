"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Flex,
  SimpleGrid,
  Text,
  Stack,
  Textarea,
  Input,
  Slider,
  ColorPicker,
  HStack,
  Portal,
  parseColor,
} from "@chakra-ui/react";
import {
  PANEL_PX,
  PanelTabs,
  SectionLabel,
  SelectedCheck,
  chipProps,
  softFieldProps,
  studioSliderCss,
  tileProps,
} from "./panel-ui";
import { Plus, X, Bold } from "lucide-react";
import { BrandFontPicker, brandFontReference } from "@/app/(app)/brand-kit/_components/brand-fonts";
import { useStudio } from "../studio-shell";
import { STUDIO_EDIT_LIMITS, type StudioTextLayer } from "@narriflow/validators";

// Preview styles mirror the USER text-layer colors that get burned in —
// they intentionally stay literal.
const PRESETS = [
  { id: "lower-third",  label: "Lower Third",  preview: "Name / Title",     lowered: true,  style: { fontSize: "11px", fontWeight: "600", color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.8)" } },
  { id: "title-card",   label: "Title Card",   preview: "BIG TITLE",        lowered: false, style: { fontSize: "14px", fontWeight: "900", color: "#fff", letterSpacing: "0.08em" } },
  { id: "minimal",      label: "Minimal",      preview: "subtitle text",    lowered: false, style: { fontSize: "11px", color: "#ccc", letterSpacing: "0.1em" } },
  { id: "bold-callout", label: "Bold Callout", preview: "KEY POINT",        lowered: false, style: { fontSize: "13px", fontWeight: "900", color: "#00ff88" } },
  { id: "quote",        label: "Quote",        preview: '"Inspiring quote"', lowered: false, style: { fontSize: "11px", color: "#fbbf24", fontStyle: "italic" } },
  { id: "caption",      label: "Caption",      preview: "Description text", lowered: false, style: { fontSize: "11px", color: "#aaa" } },
];

// Same font list captions-panel.tsx offers — kept as a separate local copy
// since neither panel exports its constants and the two style engines
// (caption cue vs. burned-in text layer) intentionally stay decoupled.
const FONTS = [
  "Bebas Neue", "Impact", "Arial", "Roboto",
  "Montserrat", "Oswald", "Open Sans",
];

// Not schema-enforced (studioTextLayerSchema only requires endSec > startSec)
// — a UI-level floor so a retime drag/field edit can't collapse a layer to
// an unusably thin (or zero-width) sliver, matching the timeline track's
// own minimum chip duration.
const MIN_TEXT_LAYER_DURATION_SEC = 0.5;

// Chip look for controls that sit inside the layer card (already studio.subtle):
// resting chips lift to raised so they stay visible against it.
function insetChipProps(selected: boolean) {
  return {
    ...chipProps(selected),
    ...(selected ? {} : { bg: "studio.raised", _hover: { bg: "studio.borderStrong", color: "studio.fg" } }),
  } as const;
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
      cursor="pointer"
      onClick={onClick}
      {...insetChipProps(active)}
      w="56px"
      h="48px"
      px="0"
      fontSize="11px"
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
  // `onChange` fires continuously while dragging inside the picker area —
  // the caller bakes a per-field coalesce key into its own `update(...)`
  // call, so all we need to do here is close out that coalesce chain when
  // the picker closes, so a single drag lands as one undo frame instead of
  // one per pointermove.
  const { endCoalesce } = useStudio("endCoalesce");
  return (
    <Box>
      <Text fontSize="11px" color="studio.fgMuted" mb="5px">{label}</Text>
      <ColorPicker.Root
        value={parseColor(value)}
        onValueChange={(e) => onChange(e.value.toString("hex"))}
        onOpenChange={(e) => {
          if (!e.open) endCoalesce();
        }}
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
            <ColorPicker.Content bg="studio.raised" borderWidth="0" borderRadius="12px" boxShadow="none">
              <ColorPicker.Area />
              <HStack>
                <ColorPicker.EyeDropper size="xs" variant="ghost" bg="studio.borderStrong" color="studio.fg" />
                <ColorPicker.Sliders />
              </HStack>
            </ColorPicker.Content>
          </ColorPicker.Positioner>
        </Portal>
      </ColorPicker.Root>
    </Box>
  );
}

// ─── Selected layer's edit form ────────────────────────────────────────────

function TextLayerDetail({ layer }: { layer: StudioTextLayer }) {
  const { setStudioEdits, endCoalesce, duration } = useStudio("setStudioEdits", "endCoalesce", "duration");

  const update = (patch: Partial<StudioTextLayer>, coalesceKey?: string) => {
    setStudioEdits((prev) => ({
      ...prev,
      textLayers: prev.textLayers.map((l) => (l.id === layer.id ? { ...l, ...patch } : l)),
    }), coalesceKey);
  };

  // Local echo for the timing inputs — a raw typed value ("12.", "") isn't
  // always a valid commit, so these only sync FROM the document (including
  // when an outside gesture like a timeline drag moves this same layer) and
  // commit back to it on blur/Enter, not on every keystroke.
  const [startInput, setStartInput] = useState(layer.startSec.toFixed(2));
  const [endInput, setEndInput] = useState(layer.endSec != null ? layer.endSec.toFixed(2) : "");

  // Same local-draft pattern for the text field itself: `text` is required
  // (studioTextLayerSchema enforces `.trim().min(1)`), so committing an
  // empty value would fail the PUT and jam autosave for every subsequent
  // edit. Keystrokes still commit live (coalesced) as long as the trimmed
  // draft is non-empty; a fully-cleared field just stops committing until
  // either more text is typed or the field is blurred, at which point an
  // empty draft reverts to the last stored value instead of committing "".
  const [textDraft, setTextDraft] = useState(layer.text);

  // biome-ignore lint/correctness/useExhaustiveDependencies: layer.id resets the local draft when selection changes even if times match.
  useEffect(() => {
    setStartInput(layer.startSec.toFixed(2));
    setEndInput(layer.endSec != null ? layer.endSec.toFixed(2) : "");
  }, [layer.id, layer.startSec, layer.endSec]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: layer.id resets the local draft when selection changes even if text matches.
  useEffect(() => {
    setTextDraft(layer.text);
  }, [layer.id, layer.text]);

  const commitStart = () => {
    // Number("") is 0, not NaN — without this guard, clearing the field and
    // blurring would silently commit startSec 0 instead of reverting.
    if (startInput.trim() === "") {
      setStartInput(layer.startSec.toFixed(2));
      return;
    }
    const val = Number(startInput);
    if (!Number.isFinite(val)) {
      setStartInput(layer.startSec.toFixed(2));
      return;
    }
    const maxStart = Math.max(0, (layer.endSec ?? duration) - MIN_TEXT_LAYER_DURATION_SEC);
    const clamped = Math.max(0, Math.min(val, maxStart, duration));
    update({ startSec: clamped });
    setStartInput(clamped.toFixed(2));
  };

  const commitEnd = () => {
    if (endInput.trim() === "") {
      update({ endSec: null });
      return;
    }
    const val = Number(endInput);
    if (!Number.isFinite(val)) {
      setEndInput(layer.endSec != null ? layer.endSec.toFixed(2) : "");
      return;
    }
    const minEnd = layer.startSec + MIN_TEXT_LAYER_DURATION_SEC;
    // `minEnd` can exceed `duration` when startSec already sits within
    // MIN_TEXT_LAYER_DURATION_SEC of the clip end — floor it at `duration`
    // too so the result can never spill past the clip boundary (a layer
    // this close to the end just gets a shorter-than-ideal duration rather
    // than an out-of-range endSec).
    const effectiveMinEnd = Math.min(minEnd, duration);
    const clamped = Math.max(effectiveMinEnd, Math.min(val, duration));
    update({ endSec: clamped });
    setEndInput(clamped.toFixed(2));
  };

  const commitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  return (
    <Stack
      gap="14px"
      px="14px"
      py="14px"
      mt="6px"
      borderRadius="10px"
      bg="studio.subtle"
    >
      <Box>
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="6px">Text</Text>
        <Textarea
          value={textDraft}
          maxLength={STUDIO_EDIT_LIMITS.textLayerChars}
          onChange={(event) => {
            const next = event.target.value.slice(0, STUDIO_EDIT_LIMITS.textLayerChars);
            setTextDraft(next);
            // Never commit an empty (or all-whitespace) value — the schema
            // requires non-empty text (it trims server-side), and a
            // rejected PUT jams autosave for every subsequent edit.
            // Non-empty keystrokes still commit live, coalesced under one
            // undo frame per this layer's text field.
            if (next.trim()) {
              update({ text: next }, `text-layer-text-${layer.id}`);
            }
          }}
          onBlur={() => {
            const trimmed = textDraft.trim();
            if (!trimmed) {
              // Field was cleared entirely — revert to the last stored
              // (committed) value instead of leaving an empty draft that
              // looks saved but never made it into the document.
              setTextDraft(layer.text);
            } else if (trimmed !== textDraft) {
              setTextDraft(trimmed);
              update({ text: trimmed });
            }
            endCoalesce();
          }}
          rows={2}
          size="sm"
          variant="outline"
          fontSize="13px"
          {...softFieldProps}
              bg="studio.canvas"
          resize="vertical"
        />
      </Box>

      <Box>
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="6px">Font</Text>
        <Flex gap="6px" wrap="wrap">
          {FONTS.map((f) => {
            const isActive = !layer.fontAsset && layer.fontName === f;
            return (
              <Box
                key={f}
                as="button"
                aria-pressed={isActive}
                cursor="pointer"
                onClick={() => update({ fontName: f, fontAsset: null })}
                {...insetChipProps(isActive)}
                px="10px"
                fontSize="12px"
                style={{ fontFamily: `"${f}", Arial, sans-serif` }}
              >
                {f}
              </Box>
            );
          })}
        </Flex>
      </Box>

<BrandFontPicker studio value={layer.fontAsset} onChange={(font) => update({ fontName: "Arial", fontAsset: font ? brandFontReference(font) : null })} />

      <Flex gap="10px" align="flex-end">
        <Box flex="1">
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="6px">Font size</Text>
          <Flex align="center" gap="10px">
            <Slider.Root
              aria-label={["Font size"]}
              value={[layer.fontSize]}
              min={8}
              max={160}
              step={1}
              onValueChange={(e) => update({ fontSize: e.value[0]! }, `text-layer-fontsize-${layer.id}`)}
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
            <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" w="28px" textAlign="right">
              {layer.fontSize}
            </Text>
          </Flex>
        </Box>
        {!layer.fontAsset ? <ToggleBtn
          icon={<Bold size={14} />}
          label="Bold"
          active={layer.bold}
          onClick={() => update({ bold: !layer.bold })}
        /> : null}
      </Flex>

      <Flex gap="12px">
        <ColorField
          label="Text"
          value={layer.color}
          onChange={(v) => update({ color: v }, `text-layer-color-${layer.id}`)}
        />
        <ColorField
          label="Outline"
          value={layer.outlineColor}
          onChange={(v) => update({ outlineColor: v }, `text-layer-outline-color-${layer.id}`)}
        />
      </Flex>

      <Box>
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="6px">Outline width</Text>
        <Flex align="center" gap="10px">
          <Slider.Root
            aria-label={["Outline width"]}
            value={[layer.outlineWidth]}
            min={0}
            max={8}
            step={1}
            onValueChange={(e) => update({ outlineWidth: e.value[0]! }, `text-layer-outline-${layer.id}`)}
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
          <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" w="16px">
            {layer.outlineWidth}
          </Text>
        </Flex>
      </Box>

      <Box>
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="6px">Background</Text>
        <Flex gap="6px" align="center" mb="8px">
          <ToggleBtn
            icon={<Box w="14px" h="14px" bg="studio.fgSubtle" borderRadius="2px" />}
            label={layer.backgroundColor ? "On" : "Off"}
            active={!!layer.backgroundColor}
            onClick={() =>
              update(
                layer.backgroundColor
                  ? { backgroundColor: null }
                  : { backgroundColor: "#000000", backgroundOpacity: 0.72 },
              )
            }
          />
          {layer.backgroundColor && (
            <ColorField
              label="Color"
              value={layer.backgroundColor}
              onChange={(v) => update({ backgroundColor: v }, `text-layer-bg-color-${layer.id}`)}
            />
          )}
        </Flex>
        {layer.backgroundColor && (
          <Flex align="center" gap="10px">
            <Text fontSize="11px" color="studio.fgMuted" w="50px">Opacity</Text>
            <Slider.Root
              aria-label={["Background opacity"]}
              value={[layer.backgroundOpacity]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(e) => update({ backgroundOpacity: e.value[0]! }, `text-layer-bgopacity-${layer.id}`)}
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
            <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" w="28px">
              {layer.backgroundOpacity.toFixed(2)}
            </Text>
          </Flex>
        )}
      </Box>

      <Box>
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="6px">Timing (seconds)</Text>
        <Flex gap="8px">
          <Box flex="1">
            <Text fontSize="10.5px" color="studio.fgSubtle" mb="3px">Start</Text>
            <Input
              type="number"
              step="0.1"
              value={startInput}
              onChange={(event) => setStartInput(event.target.value)}
              onBlur={commitStart}
              onKeyDown={commitOnEnter}
              size="sm"
              fontSize="13px"
              {...softFieldProps}
              bg="studio.canvas"
            />
          </Box>
          <Box flex="1">
            <Text fontSize="10.5px" color="studio.fgSubtle" mb="3px">End (blank = clip end)</Text>
            <Input
              type="number"
              step="0.1"
              placeholder="end"
              value={endInput}
              onChange={(event) => setEndInput(event.target.value)}
              onBlur={commitEnd}
              onKeyDown={commitOnEnter}
              size="sm"
              fontSize="13px"
              {...softFieldProps}
              bg="studio.canvas"
            />
          </Box>
        </Flex>
      </Box>
    </Stack>
  );
}

// The panel's one solid action; disabled it goes flat grey rather than a faded copy.
const primaryButtonProps = {
  w: "full",
  h: "44px",
  borderRadius: "10px",
  fontSize: "14px",
  fontWeight: "500",
  colorPalette: "brand",
  _disabled: { bg: "studio.raised", color: "studio.fgSubtle", opacity: 1, cursor: "not-allowed" },
} as const;

// A preset as a small overlay-on-video card: the sample sits on a dark mini
// frame, the name is a quiet label, and the add button shows on hover/focus
// (always on touch, and once the card is selected).
function PresetCard({
  preset,
  selected,
  disabled,
  onSelect,
  onAdd,
}: {
  preset: (typeof PRESETS)[number];
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onAdd: () => void;
}) {
  const showAdd = { opacity: 1, transform: "scale(1)" };
  return (
    <Box
      position="relative"
      css={{
        "&:hover [data-add], &:focus-within [data-add]": showAdd,
        "@media (hover: none)": { "& [data-add]": showAdd },
      }}
    >
      <Box
        as="button"
        w="full"
        p="6px"
        pb="2.5"
        textAlign="left"
        aria-pressed={selected}
        onClick={onSelect}
        {...tileProps(selected)}
      >
        <Flex
          position="relative"
          h="80px"
          px="2"
          pb={preset.lowered ? "3" : "0"}
          align={preset.lowered ? "flex-end" : "center"}
          justify="center"
          overflow="hidden"
          borderRadius="8px"
          bgGradient="to-br"
          gradientFrom="studio.raised"
          gradientTo="studio.canvas"
        >
          {/* A faint talking head, so the sample reads as an overlay on footage */}
          <Box position="absolute" bottom="-22px" insetX="0" mx="auto" w="64px" h="46px" borderRadius="full" bg="studio.borderStrong" opacity={0.4} aria-hidden />
          <Box position="absolute" bottom="18px" insetX="0" mx="auto" boxSize="22px" borderRadius="full" bg="studio.borderStrong" opacity={0.4} aria-hidden />
          <Text position="relative" style={preset.style} lineClamp="1" textAlign="center">
            {preset.preview}
          </Text>
        </Flex>
        <Text mt="2" px="1" fontSize="12px" fontWeight="500" lineHeight="1.2">
          {preset.label}
        </Text>
        <SelectedCheck show={selected} />
      </Box>
      {/* Frame-aligned layer, so the add button sits on the frame, not the label */}
      <Box position="absolute" top="6px" insetX="6px" h="80px" pointerEvents="none">
        <Box
          as="button"
          data-add
          aria-label={`Add ${preset.label} overlay`}
          aria-disabled={disabled}
          position="absolute"
          top="2"
          insetStart="2"
          boxSize="26px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          borderRadius="full"
          bg={disabled ? "studio.raised" : "studio.fg"}
          color={disabled ? "studio.fgSubtle" : "studio.canvas"}
          pointerEvents="auto"
          cursor={disabled ? "not-allowed" : "pointer"}
          opacity={selected ? 1 : 0.55}
          transform={selected ? "scale(1)" : "scale(0.92)"}
          transition="opacity 120ms ease, transform 120ms ease"
          _hover={disabled ? undefined : { transform: "scale(1.08)" }}
          onClick={onAdd}
        >
          <Plus size={14} strokeWidth={2.5} />
        </Box>
      </Box>
    </Box>
  );
}

// Slider with its name and live value on one row above it.
function SliderRow({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <Box>
      <SectionLabel
        action={
          <Text fontVariantNumeric="tabular-nums" fontSize="13px" color="studio.fg">
            {value}
          </Text>
        }
      >
        {label}
      </SectionLabel>
      <Slider.Root
        aria-label={[label]}
        value={[value]}
        min={min}
        max={max}
        onValueChange={(event) => onChange(event.value[0] ?? value)}
        size="sm"
        css={studioSliderCss}
      >
        <Slider.Control>
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          <Slider.Thumbs />
        </Slider.Control>
      </Slider.Root>
    </Box>
  );
}

/** `studioEditsSchema.textLayers`'s cap; past it the document can't save. */
export const MAX_TEXT_LAYERS = STUDIO_EDIT_LIMITS.textLayers;

export function TextPanel() {
  const {
    studioEdits, setStudioEdits, playbackClock, duration,
    selectedTextLayerId, selectTextLayer, deselectTextLayer, seekTo,
  } = useStudio("studioEdits", "setStudioEdits", "playbackClock", "duration", "selectedTextLayerId", "selectTextLayer", "deselectTextLayer", "seekTo");
  const [activeTab, setActiveTab] = useState<"presets" | "custom">("presets");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");
  const [fontSize, setFontSize] = useState(44);
  const atLayerCap = studioEdits.textLayers.length >= MAX_TEXT_LAYERS;

  const addLayer = (input: {
    text: string;
    fontSize?: number;
    color?: string;
    positionY?: number;
    bold?: boolean;
  }) => {
    const text = input.text.trim();
    if (!text || atLayerCap) return;
    const id = crypto.randomUUID();
    // Clamp to `duration - MIN_TEXT_LAYER_DURATION_SEC` so a layer added at
    // (or after) the clip's end still gets a visible, non-degenerate
    // window instead of starting past the point where it can ever show.
    const startSec = Math.max(
      0,
      Math.min(playbackClock.getSnapshot(), Math.max(0, duration - MIN_TEXT_LAYER_DURATION_SEC)),
    );
    const endSec = Math.min(duration, startSec + 6);
    setStudioEdits((prev) => ({
      ...prev,
      textLayers: [
        ...prev.textLayers,
        {
          id,
          text,
          startSec,
          endSec: endSec > startSec + 0.5 ? endSec : null,
          positionX: 50,
          positionY: input.positionY ?? 18,
          fontName: "Arial",
          fontSize: input.fontSize ?? 44,
          color: input.color ?? "#FFFFFF",
          backgroundColor: null,
          backgroundOpacity: 0.72,
          bold: input.bold ?? true,
          outlineColor: "#000000",
          outlineWidth: 2,
        },
      ],
    }));
    selectTextLayer(id);
  };

  const removeLayer = (id: string) => {
    setStudioEdits((prev) => ({
      ...prev,
      textLayers: prev.textLayers.filter((layer) => layer.id !== id),
    }));
    if (selectedTextLayerId === id) deselectTextLayer();
  };

  return (
    <Stack gap="0">
      {/* Tabs */}
      <PanelTabs
        ariaLabel="Text overlays"
        items={[
          { id: "presets", label: "Presets" },
          { id: "custom", label: "Custom" },
        ]}
        value={activeTab}
        onChange={setActiveTab}
      />

      {atLayerCap ? (
        <Text px={PANEL_PX} pt="14px" fontSize="12px" color="studio.fgMuted">
          A clip holds up to {MAX_TEXT_LAYERS} text layers. Remove one to add another.
        </Text>
      ) : null}

      {activeTab === "presets" && (
        <SimpleGrid columns={2} gap="2" px={PANEL_PX} pt="4" pb="4">
          {PRESETS.map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              selected={selectedPreset === p.id}
              disabled={atLayerCap}
              onSelect={() => setSelectedPreset(selectedPreset === p.id ? null : p.id)}
              onAdd={() =>
                addLayer({
                  text: p.preview,
                  fontSize: p.id === "title-card" ? 62 : 42,
                  color:
                    p.id === "bold-callout"
                      ? "#00FF88"
                      : p.id === "quote"
                        ? "#FBBF24"
                        : "#FFFFFF",
                  positionY: p.id === "lower-third" ? 76 : 18,
                  bold: p.id !== "minimal",
                })
              }
            />
          ))}
        </SimpleGrid>
      )}

      {activeTab === "custom" && (
        <Stack gap="5" px={PANEL_PX} pt="4" pb="4">
          <Box>
            <SectionLabel>Text</SectionLabel>
            <Textarea
              placeholder="Type your text..."
              value={customText}
              maxLength={STUDIO_EDIT_LIMITS.textLayerChars}
              onChange={(event) => setCustomText(event.target.value.slice(0, STUDIO_EDIT_LIMITS.textLayerChars))}
              rows={3}
              size="sm"
              variant="outline"
              fontSize="14px"
              {...softFieldProps}
              resize="vertical"
            />
          </Box>
          <SliderRow label="Font size" value={fontSize} min={12} max={80} onChange={setFontSize} />
          <Button
            {...primaryButtonProps}
            disabled={atLayerCap || !customText.trim()}
            onClick={() => {
              addLayer({ text: customText, fontSize });
              setCustomText("");
            }}
          >
            <Plus size={16} />
            Add text overlay
          </Button>
        </Stack>
      )}

      {studioEdits.textLayers.length > 0 && (
        <Box px={PANEL_PX} pb="5" pt="1">
          <SectionLabel>Layers</SectionLabel>
          <Stack gap="6px">
            {studioEdits.textLayers.map((layer) => {
              const isSelected = selectedTextLayerId === layer.id;
              return (
                <Box key={layer.id}>
                  <Flex
                    align="center"
                    justify="space-between"
                    px="14px"
                    py="10px"
                    {...tileProps(isSelected)}
                    onClick={() => {
                      selectTextLayer(layer.id);
                      seekTo(layer.startSec);
                    }}
                  >
                    <Box minW="0">
                      <Text fontSize="13px" color="studio.fg" overflow="hidden" whiteSpace="nowrap" textOverflow="ellipsis">
                        {layer.text}
                      </Text>
                      <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.timecode">
                        {layer.startSec.toFixed(1)}s – {layer.endSec ? `${layer.endSec.toFixed(1)}s` : "end"}
                      </Text>
                    </Box>
                    <Box
                      as="button"
                      aria-label="Remove text layer"
                      color="studio.fgMuted"
                      p="4px"
                      cursor="pointer"
                      _hover={{ color: "danger.400" }}
                      transition="color 120ms ease"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeLayer(layer.id);
                      }}
                    >
                      <X size={13} />
                    </Box>
                  </Flex>
                  {isSelected && <TextLayerDetail layer={layer} />}
                </Box>
              );
            })}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
