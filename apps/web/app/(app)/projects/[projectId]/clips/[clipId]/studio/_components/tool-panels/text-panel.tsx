"use client";

/**
 * The Text panel (title-text spec section 6). Presets: "Add a title" (the clip's own title, one per
 * clip), "Add body text", the six recommended styles drawn by the real painter, and the clip's
 * layers. Settings, for the selected layer: its words, the shared style controls, its timing and,
 * for a title, Apply to all clips. Selecting a layer opens Settings; deleting it returns to Presets.
 */

import { useEffect, useRef, useState } from "react";
import { Box, Flex, Input, SimpleGrid, Stack, Text, Textarea, chakra } from "@chakra-ui/react";
import { Heading, Layers, Trash2, Type, X } from "lucide-react";
import { STUDIO_EDIT_LIMITS, type StudioTextLayer, TEXT_LAYER_STYLE_PRESETS, type TextLayerStyle } from "@narriflow/validators";
import { PANEL_PX, PanelTabs, SectionLabel, SelectedCheck, softFieldProps, tileProps } from "./panel-ui";
import { TextStyleControls } from "./text-style-controls";
import { TextStyleSample } from "../text-layer-sample";
import { MAX_TEXT_LAYERS, MIN_TEXT_LAYER_DURATION_SEC, presetTarget } from "../text-layer-commands";
import { requestApplyTitleToAll, useTextFieldFocusRequest, useTextLayerCommands } from "../studio-text-layers";

export { MAX_TEXT_LAYERS };

type Tab = "presets" | "settings";

/** Two styles look the same (size and brand font aside, which a preset keeps). */
function sameLook(a: TextLayerStyle, b: TextLayerStyle): boolean {
  return JSON.stringify({ ...a, fontSize: 0, fontAsset: null }) === JSON.stringify({ ...b, fontSize: 0, fontAsset: null });
}

const capNote = `A clip holds up to ${MAX_TEXT_LAYERS} text layers. Delete one to add another.`;

export function TextPanel() {
  const commands = useTextLayerCommands();
  const { layers, selectedId } = commands;
  const selected = selectedId ? (layers.find((layer) => layer.id === selectedId) ?? null) : null;
  const [tab, setTab] = useState<Tab>(selected ? "settings" : "presets");
  // Selecting a layer opens Settings; losing the selection (a delete, Escape) returns to Presets.
  useEffect(() => {
    setTab(selectedId ? "settings" : "presets");
  }, [selectedId]);
  const showing: Tab = selected ? tab : "presets";

  return (
    <Stack gap="0">
      <PanelTabs
        ariaLabel="Text"
        items={selected ? [{ id: "presets", label: "Presets" }, { id: "settings", label: "Settings" }] : [{ id: "presets", label: "Presets" }]}
        value={showing}
        onChange={setTab}
      />
      {showing === "settings" && selected ? <SettingsTab layer={selected} commands={commands} /> : <PresetsTab commands={commands} />}
    </Stack>
  );
}

type Commands = ReturnType<typeof useTextLayerCommands>;

function AddButton({ label, sub, icon, large, disabled, onClick }: { label: string; sub?: string; icon: React.ReactNode; large?: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <Flex
      as="button"
      w="full"
      h={large ? "56px" : "48px"}
      align="center"
      justify="center"
      gap="2.5"
      borderRadius="12px"
      bg="studio.subtle"
      color="studio.fg"
      fontSize={large ? "17px" : "14px"}
      fontWeight={large ? "600" : "500"}
      cursor={disabled ? "not-allowed" : "pointer"}
      aria-disabled={disabled}
      transition="background 120ms ease"
      _hover={disabled ? undefined : { bg: "studio.surface" }}
      onClick={disabled ? undefined : onClick}
    >
      <Box color="studio.fgMuted">{icon}</Box>
      {label}
      {sub ? (
        <Text as="span" fontSize="12px" fontWeight="400" color="studio.fgSubtle">
          {sub}
        </Text>
      ) : null}
    </Flex>
  );
}

function PresetsTab({ commands }: { commands: Commands }) {
  const { layers, title, atLayerCap, selectedId, addTitle, addBody, applyPreset, select, remove } = commands;
  // The layer a card would restyle, so the card that matches it shows as chosen.
  const target = presetTarget(layers, selectedId);
  const targetLayer = target.kind === "restyle" ? layers.find((layer) => layer.id === target.id) : undefined;

  return (
    <Stack gap="5" px={PANEL_PX} pt="4" pb="5">
      <Stack gap="2">
        {/* With a title on the clip this selects it: one title per clip. */}
        <AddButton label={title ? "Edit the title" : "Add a title"} icon={<Heading size={18} />} large disabled={!title && atLayerCap} onClick={() => addTitle()} />
        <AddButton label="Add body text" icon={<Type size={16} />} disabled={atLayerCap} onClick={addBody} />
        {atLayerCap ? (
          <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5">
            {capNote}
          </Text>
        ) : null}
      </Stack>

      <Box>
        <SectionLabel>Recommended</SectionLabel>
        <SimpleGrid columns={2} gap="2">
          {TEXT_LAYER_STYLE_PRESETS.map((preset) => {
            const chosen = targetLayer ? sameLook(targetLayer.style, preset.style) : false;
            const action = target.kind === "add" ? (atLayerCap ? null : "Add a title in") : targetLayer?.role === "title" ? "Restyle the title as" : "Restyle the text as";
            return (
              <Box
                key={preset.id}
                as="button"
                aria-label={action ? `${action} ${preset.name}` : `${preset.name} (${capNote})`}
                aria-pressed={chosen}
                aria-disabled={action === null}
                p="6px"
                {...tileProps(chosen)}
                cursor={action ? "pointer" : "not-allowed"}
                onClick={action ? () => applyPreset(preset.style) : undefined}
              >
                <Box borderRadius="8px" overflow="hidden" bg="#7C828C">
                  {/* The sample backdrop is a fixed mid grey so light and dark styles both read. */}
                  <TextStyleSample style={preset.style} />
                </Box>
                <Text mt="1.5" px="1" pb="0.5" fontSize="12px" fontWeight="500" textAlign="left">
                  {preset.name}
                </Text>
                <SelectedCheck show={chosen} />
              </Box>
            );
          })}
        </SimpleGrid>
      </Box>

      {layers.length > 0 ? (
        <Box>
          <SectionLabel>On this clip</SectionLabel>
          <Stack gap="1.5">
            {layers.map((layer) => (
              <LayerRow key={layer.id} layer={layer} selected={layer.id === selectedId} onSelect={() => select(layer.id, { seek: true })} onRemove={() => remove(layer.id)} />
            ))}
          </Stack>
        </Box>
      ) : null}
    </Stack>
  );
}

function LayerRow({ layer, selected, onSelect, onRemove }: { layer: StudioTextLayer; selected: boolean; onSelect: () => void; onRemove: () => void }) {
  const kind = layer.role === "title" ? "Title" : "Body text";
  return (
    <Flex align="center" gap="2" ps="3" pe="1" py="1.5" {...tileProps(selected)} borderRadius="10px">
      <Flex as="button" flex="1" minW="0" align="center" gap="2.5" textAlign="left" cursor="pointer" aria-label={`Select ${kind.toLowerCase()} "${layer.text}"`} aria-pressed={selected} onClick={onSelect}>
        <Box color={selected ? "studio.accentFg" : "studio.fgMuted"} flexShrink={0}>
          {layer.role === "title" ? <Heading size={14} /> : <Type size={14} />}
        </Box>
        <Box minW="0">
          <Text fontSize="13px" color="studio.fg" truncate>
            {layer.text}
          </Text>
          <Text fontSize="11.5px" color="studio.timecode" fontVariantNumeric="tabular-nums">
            {kind} · {layer.startSec.toFixed(1)}s – {layer.endSec != null ? `${layer.endSec.toFixed(1)}s` : "end"}
          </Text>
        </Box>
      </Flex>
      <Flex as="button" aria-label={`Delete ${kind.toLowerCase()} "${layer.text}"`} boxSize="28px" align="center" justify="center" borderRadius="8px" color="studio.fgMuted" cursor="pointer" _hover={{ bg: "studio.raised", color: "studio.fg" }} onClick={onRemove}>
        <X size={14} />
      </Flex>
    </Flex>
  );
}

function SettingsTab({ layer, commands }: { layer: StudioTextLayer; commands: Commands }) {
  const { update, updateStyle, endCoalesce, remove, clipDurationSec } = commands;
  return (
    <Stack gap="4" px={PANEL_PX} pt="4" pb="5">
      <TextField layer={layer} onChange={(text, gesture) => update(layer.id, { text }, gesture)} onEnd={endCoalesce} />
      <TextStyleControls value={layer.style} onChange={(patch, gesture) => updateStyle(layer.id, patch, gesture)} onGestureEnd={endCoalesce} />
      <TimingFields layer={layer} clipDurationSec={clipDurationSec} onChange={(patch) => update(layer.id, patch)} />
      <Stack gap="2">
        {layer.role === "title" ? (
          <AddButton label="Apply to all clips" icon={<Layers size={16} />} disabled={false} onClick={() => requestApplyTitleToAll(layer.id)} />
        ) : null}
        <Flex as="button" align="center" justify="center" gap="2" h="40px" borderRadius="10px" color="studio.fgMuted" fontSize="13px" cursor="pointer" _hover={{ bg: "studio.subtle", color: "studio.fg" }} onClick={() => remove(layer.id)}>
          <Trash2 size={14} />
          Delete {layer.role === "title" ? "title" : "text"}
        </Flex>
      </Stack>
    </Stack>
  );
}

/**
 * The layer's words. Typing commits live (one undo step per editing run) while the draft has words;
 * an empty or blank draft is never committed and returns to the saved text on blur. Delete and
 * Backspace here edit characters (the Studio's shortcuts ignore text fields).
 */
function TextField({ layer, onChange, onEnd }: { layer: StudioTextLayer; onChange: (text: string, gesture?: string) => void; onEnd: () => void }) {
  const [draft, setDraft] = useState(layer.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const focus = useTextFieldFocusRequest();
  // biome-ignore lint/correctness/useExhaustiveDependencies: layer.id resets the draft when the selection changes even if the words match.
  useEffect(() => {
    setDraft(layer.text);
  }, [layer.id, layer.text]);
  // A double-click on the canvas asked for this layer's words.
  useEffect(() => {
    if (focus.id !== layer.id || !ref.current) return;
    ref.current.focus();
    ref.current.select();
    focus.done();
  }, [focus, layer.id]);
  return (
    <Box>
      <chakra.label htmlFor={`text-layer-text-${layer.id}`} display="block" fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="2">Text</chakra.label>
      <Textarea
        ref={ref}
        id={`text-layer-text-${layer.id}`}
        value={draft}
        maxLength={STUDIO_EDIT_LIMITS.textLayerChars}
        onChange={(event) => {
          const next = event.target.value.slice(0, STUDIO_EDIT_LIMITS.textLayerChars);
          setDraft(next);
          if (next.trim()) onChange(next, "text");
        }}
        onBlur={() => {
          const trimmed = draft.trim();
          if (!trimmed) setDraft(layer.text);
          else if (trimmed !== draft) {
            setDraft(trimmed);
            onChange(trimmed, "text");
          }
          onEnd();
        }}
        rows={3}
        fontSize="14px"
        lineHeight="1.5"
        {...softFieldProps}
        resize="vertical"
      />
    </Box>
  );
}

/** Start and end, seconds on the clip's edited timeline; a blank end means until the clip ends. */
function TimingFields({ layer, clipDurationSec, onChange }: { layer: StudioTextLayer; clipDurationSec: number; onChange: (patch: Pick<StudioTextLayer, "startSec"> | Pick<StudioTextLayer, "endSec">) => void }) {
  const format = (value: number | null | undefined) => (value == null ? "" : value.toFixed(2));
  const [start, setStart] = useState(format(layer.startSec));
  const [end, setEnd] = useState(format(layer.endSec));
  // biome-ignore lint/correctness/useExhaustiveDependencies: layer.id resets the drafts when the selection changes even if the times match.
  useEffect(() => {
    setStart(format(layer.startSec));
    setEnd(format(layer.endSec));
  }, [layer.id, layer.startSec, layer.endSec]);

  const commitStart = () => {
    const value = Number(start);
    if (start.trim() === "" || !Number.isFinite(value)) return setStart(format(layer.startSec));
    const latest = Math.max(0, (layer.endSec ?? clipDurationSec) - MIN_TEXT_LAYER_DURATION_SEC);
    const next = Math.max(0, Math.min(value, latest));
    setStart(format(next));
    if (next !== layer.startSec) onChange({ startSec: next });
  };
  const commitEnd = () => {
    if (end.trim() === "") {
      if (layer.endSec != null) onChange({ endSec: null });
      return;
    }
    const value = Number(end);
    if (!Number.isFinite(value)) return setEnd(format(layer.endSec));
    // The footage wins on a clip shorter than the minimum: never past the clip's end.
    const earliest = Math.min(layer.startSec + MIN_TEXT_LAYER_DURATION_SEC, clipDurationSec);
    const next = Math.max(earliest, Math.min(value, clipDurationSec));
    if (!(next > layer.startSec)) return setEnd(format(layer.endSec));
    setEnd(format(next));
    if (next !== layer.endSec) onChange({ endSec: next });
  };
  const blurOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
  };
  return (
    <Box>
      <SectionLabel>Timing</SectionLabel>
      <Flex gap="2">
        <Box flex="1">
          <chakra.label htmlFor={`text-layer-start-${layer.id}`} display="block" fontSize="12px" color="studio.fgSubtle" mb="1">Start (s)</chakra.label>
          <Input id={`text-layer-start-${layer.id}`} inputMode="decimal" value={start} onChange={(event) => setStart(event.target.value)} onBlur={commitStart} onKeyDown={blurOnEnter} h="40px" fontSize="14px" fontVariantNumeric="tabular-nums" {...softFieldProps} />
        </Box>
        <Box flex="1">
          <chakra.label htmlFor={`text-layer-end-${layer.id}`} display="block" fontSize="12px" color="studio.fgSubtle" mb="1">End (s)</chakra.label>
          <Input id={`text-layer-end-${layer.id}`} inputMode="decimal" placeholder="Clip end" value={end} onChange={(event) => setEnd(event.target.value)} onBlur={commitEnd} onKeyDown={blurOnEnter} h="40px" fontSize="14px" fontVariantNumeric="tabular-nums" {...softFieldProps} />
        </Box>
      </Flex>
    </Box>
  );
}
