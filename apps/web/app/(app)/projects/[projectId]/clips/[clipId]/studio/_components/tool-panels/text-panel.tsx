"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Flex,
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
import { Plus, X, Bold } from "lucide-react";
import { useStudio } from "../studio-shell";
import type { StudioTextLayer } from "@narriflow/validators";

// Preview styles mirror the USER text-layer colors that get burned in —
// they intentionally stay literal.
const PRESETS = [
  { id: "lower-third",  label: "Lower Third",  preview: "Name / Title",     style: { fontSize: "11px", fontWeight: "600", color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.8)" } },
  { id: "title-card",   label: "Title Card",   preview: "BIG TITLE",        style: { fontSize: "14px", fontWeight: "900", color: "#fff", letterSpacing: "0.08em" } },
  { id: "minimal",      label: "Minimal",      preview: "subtitle text",    style: { fontSize: "11px", color: "#ccc", letterSpacing: "0.1em" } },
  { id: "bold-callout", label: "Bold Callout", preview: "KEY POINT",        style: { fontSize: "13px", fontWeight: "900", color: "#00ff88" } },
  { id: "quote",        label: "Quote",        preview: '"Inspiring quote"', style: { fontSize: "11px", color: "#fbbf24", fontStyle: "italic" } },
  { id: "caption",      label: "Caption",      preview: "Description text", style: { fontSize: "11px", color: "#aaa" } },
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
  // `onChange` fires continuously while dragging inside the picker area —
  // the caller bakes a per-field coalesce key into its own `update(...)`
  // call, so all we need to do here is close out that coalesce chain when
  // the picker closes, so a single drag lands as one undo frame instead of
  // one per pointermove.
  const { endCoalesce } = useStudio();
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

// ─── Selected layer's edit form ────────────────────────────────────────────

function TextLayerDetail({ layer }: { layer: StudioTextLayer }) {
  const { setStudioEdits, endCoalesce, duration } = useStudio();

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
      gap="10px"
      px="10px"
      py="10px"
      mt="4px"
      borderRadius="l2"
      bg="studio.raised"
      borderWidth="1px"
      borderColor="studio.accent"
    >
      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">Text</Text>
        <Textarea
          value={textDraft}
          maxLength={280}
          onChange={(event) => {
            const next = event.target.value.slice(0, 280);
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
          fontSize="12px"
          bg="studio.subtle"
          borderColor="studio.borderControl"
          color="studio.fg"
          _focusVisible={{ borderColor: "studio.ring", boxShadow: "none" }}
          resize="vertical"
        />
      </Box>

      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">Font</Text>
        <Flex gap="6px" wrap="wrap">
          {FONTS.map((f) => {
            const isActive = layer.fontName === f;
            return (
              <Box
                key={f}
                as="button"
                aria-pressed={isActive}
                px="8px"
                py="5px"
                borderRadius="l2"
                bg={isActive ? "studio.subtle" : "transparent"}
                border="1px solid"
                borderColor={isActive ? "studio.accent" : "studio.border"}
                cursor="pointer"
                onClick={() => update({ fontName: f })}
                transition="background 120ms ease, border-color 120ms ease"
                _hover={{ borderColor: isActive ? "studio.accent" : "studio.borderStrong" }}
              >
                <Text
                  fontSize="11px"
                  color={isActive ? "studio.accentFg" : "studio.fgMuted"}
                  style={{ fontFamily: `"${f}", Arial, sans-serif` }}
                >
                  {f}
                </Text>
              </Box>
            );
          })}
        </Flex>
      </Box>

      <Flex gap="10px" align="flex-end">
        <Box flex="1">
          <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">Font size</Text>
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
            <Text textStyle="data" fontSize="12px" color="studio.fgMuted" w="28px" textAlign="right">
              {layer.fontSize}
            </Text>
          </Flex>
        </Box>
        <ToggleBtn
          icon={<Bold size={14} />}
          label="Bold"
          active={layer.bold}
          onClick={() => update({ bold: !layer.bold })}
        />
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
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">Outline width</Text>
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
            {layer.outlineWidth}
          </Text>
        </Flex>
      </Box>

      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">Background</Text>
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
              {layer.backgroundOpacity.toFixed(2)}
            </Text>
          </Flex>
        )}
      </Box>

      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">Timing (seconds)</Text>
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
              fontSize="12px"
              bg="studio.subtle"
              borderColor="studio.borderControl"
              color="studio.fg"
              _focusVisible={{ borderColor: "studio.ring", boxShadow: "none" }}
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
              fontSize="12px"
              bg="studio.subtle"
              borderColor="studio.borderControl"
              color="studio.fg"
              _focusVisible={{ borderColor: "studio.ring", boxShadow: "none" }}
            />
          </Box>
        </Flex>
      </Box>
    </Stack>
  );
}

export function TextPanel() {
  const {
    studioEdits, setStudioEdits, playbackClock, duration,
    selectedTextLayerId, selectTextLayer, deselectTextLayer, seekTo,
  } = useStudio();
  const [activeTab, setActiveTab] = useState<"presets" | "custom">("presets");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");
  const [fontSize, setFontSize] = useState(44);

  const addLayer = (input: {
    text: string;
    fontSize?: number;
    color?: string;
    positionY?: number;
    bold?: boolean;
  }) => {
    const text = input.text.trim();
    if (!text) return;
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
      <Flex px="12px" pt="12px" gap="4px" mb="12px" role="tablist" aria-label="Text overlays">
        {(["presets", "custom"] as const).map((tab) => {
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

      {activeTab === "presets" && (
        <Stack gap="6px" px="12px" pb="12px">
          {PRESETS.map((p) => (
            <Flex
              key={p.id}
              align="center"
              justify="space-between"
              px="12px"
              py="12px"
              borderRadius="l2"
              bg={selectedPreset === p.id ? "studio.raised" : "studio.subtle"}
              border="1px solid"
              borderColor={selectedPreset === p.id ? "studio.accent" : "studio.border"}
              cursor="pointer"
              onClick={() => setSelectedPreset(selectedPreset === p.id ? null : p.id)}
              transition="background 120ms ease, border-color 120ms ease"
              _hover={{ borderColor: selectedPreset === p.id ? "studio.accent" : "studio.borderStrong" }}
            >
              <Box>
                <Text fontSize="11px" color="studio.fgMuted" mb="3px" fontWeight="500">{p.label}</Text>
                <Text style={p.style}>{p.preview}</Text>
              </Box>
              <Box
                as="button"
                aria-label={`Add ${p.label} overlay`}
                w="26px"
                h="26px"
                borderRadius="full"
                bg="studio.raised"
                borderWidth="1px"
                borderColor="studio.borderStrong"
                display="flex"
                alignItems="center"
                justifyContent="center"
                cursor="pointer"
                color="studio.fgMuted"
                _hover={{ borderColor: "studio.accent", color: "studio.accentFg" }}
                transition="border-color 120ms ease, color 120ms ease"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
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
                  });
                }}
              >
                <Plus size={12} />
              </Box>
            </Flex>
          ))}
        </Stack>
      )}

      {activeTab === "custom" && (
        <Stack gap="12px" px="12px" pb="12px">
          <Box>
            <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">Text content</Text>
            <Textarea
              placeholder="Type your text..."
              value={customText}
              onChange={(event) => setCustomText(event.target.value)}
              rows={3}
              size="sm"
              variant="outline"
              fontSize="12px"
              bg="studio.subtle"
              borderColor="studio.borderControl"
              color="studio.fg"
              _placeholder={{ color: "studio.fgSubtle" }}
              _focusVisible={{ borderColor: "studio.ring", boxShadow: "none" }}
              resize="vertical"
            />
          </Box>
          <Box>
            <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">Font size</Text>
            <Flex align="center" gap="10px">
              <Slider.Root
                aria-label={["Font size"]}
                value={[fontSize]}
                min={12}
                max={80}
                onValueChange={(event) => setFontSize(event.value[0] ?? 44)}
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
              <Text textStyle="data" fontSize="12px" color="studio.fgMuted" w="24px" textAlign="right">
                {fontSize}
              </Text>
            </Flex>
          </Box>
          {/* Secondary action — Export owns the view's solid button */}
          <Flex
            as="button"
            align="center"
            justify="center"
            h="34px"
            borderRadius="l2"
            bg="studio.raised"
            borderWidth="1px"
            borderColor="studio.borderStrong"
            color="studio.fg"
            fontSize="12px"
            fontWeight="600"
            cursor="pointer"
            gap="6px"
            _hover={{ borderColor: "studio.fgSubtle" }}
            transition="border-color 120ms ease"
            onClick={() => {
              addLayer({ text: customText, fontSize });
              setCustomText("");
            }}
          >
            <Plus size={14} />
            Add text overlay
          </Flex>
        </Stack>
      )}

      {studioEdits.textLayers.length > 0 && (
        <Box px="12px" pb="12px">
          <Text textStyle="eyebrow" color="studio.fgMuted" mb="8px">
            Layers
          </Text>
          <Stack gap="4px">
            {studioEdits.textLayers.map((layer) => {
              const isSelected = selectedTextLayerId === layer.id;
              return (
                <Box key={layer.id}>
                  <Flex
                    align="center"
                    justify="space-between"
                    px="10px"
                    py="8px"
                    borderRadius="l2"
                    bg={isSelected ? "studio.raised" : "studio.subtle"}
                    borderWidth="1px"
                    borderColor={isSelected ? "studio.accent" : "studio.border"}
                    cursor="pointer"
                    transition="background 120ms ease, border-color 120ms ease"
                    _hover={{ borderColor: isSelected ? "studio.accent" : "studio.borderStrong" }}
                    onClick={() => {
                      selectTextLayer(layer.id);
                      seekTo(layer.startSec);
                    }}
                  >
                    <Box minW="0">
                      <Text fontSize="11px" color="studio.fg" overflow="hidden" whiteSpace="nowrap" textOverflow="ellipsis">
                        {layer.text}
                      </Text>
                      <Text textStyle="data" fontSize="10.5px" color="studio.timecode">
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
