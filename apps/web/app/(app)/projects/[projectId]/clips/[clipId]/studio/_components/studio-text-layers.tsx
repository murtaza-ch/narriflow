"use client";

/**
 * The Studio's Text Layers (title-text spec section 6): the canvas (`TextLayerCanvas` with the
 * floating toolbar) wired to the editor document, the commands the Text panel and the toolbar share,
 * and Apply to all clips for a title. Every gesture and control is one undo step: a continuous change
 * goes through `setStudioEdits` with a coalesce key and ends with `endCoalesce()`.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Dialog, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { Layers } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { toaster } from "@narriflow/ui/components/toaster";
import { DEFAULT_BRAND_TITLE, type StudioTextLayer, type TextLayerStyle, findTitleLayer } from "@narriflow/validators";
import type { CompositionTextVisualLayer } from "@narriflow/composition-plan";
import { createClipsClient, invalidateAfterClipChange } from "@narriflow/api-client/clips";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import { useUpgrade } from "@/app/(app)/_components/upgrade";
import { useStudio } from "./studio-shell";
import { apiFailureBody, requireStudioApi } from "./studio-api";
import { useStudioApi } from "./use-studio-api";
import { TextLayerCanvas, type TextLayerGesture, type TextLayerGesturePatch } from "./text-layer-canvas";
import { TextLayerToolbar } from "./text-layer-toolbar";
import {
  type ApplyTitleResult,
  MAX_TEXT_LAYERS,
  applyTitleResultMessage,
  duplicateTextLayer,
  newBodyLayer,
  newTitleLayer,
  patchTextLayer,
  patchTextLayerStyle,
  presetStyleFor,
  presetTarget,
  removeTextLayer,
  titlePatchOf,
} from "./text-layer-commands";

// ─── Small shared stores ─────────────────────────────────────────────────────

/** A tiny external store: the canvas asks, the Text panel (mounted on demand) answers. */
function createSignal<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A pending "edit this layer's words" from a double-click: the Settings text box takes focus once it mounts. */
const textFieldFocus = createSignal<string | null>(null);

export function requestTextFieldFocus(id: string) {
  textFieldFocus.set(id);
}

/** The layer whose text box should take focus now, and a way to say it has. */
export function useTextFieldFocusRequest(): { id: string | null; done: () => void } {
  const id = useSyncExternalStore(textFieldFocus.subscribe, textFieldFocus.get, () => null);
  return { id, done: useCallback(() => textFieldFocus.set(null), []) };
}

/** The title Apply to all clips is asked for (the confirmation is open while set). */
const applyAllRequest = createSignal<string | null>(null);

export function requestApplyTitleToAll(layerId: string) {
  applyAllRequest.set(layerId);
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * The Text Layer commands of the open clip. The title's settings come from the built-in default: the
 * Studio's loaded data has no brand template snapshot (ticket 04 note), so `DEFAULT_BRAND_TITLE`.
 */
export function useTextLayerCommands() {
  const { studioEdits, setStudioEdits, endCoalesce, selectedTextLayerId, selectTextLayer, deselectTextLayer, setActiveTool, playbackClock, compositeToBaseEdited, baseEditedToComposite, editedTimeMap, clipInfo, seekTo } = useStudio(
    "studioEdits", "setStudioEdits", "endCoalesce", "selectedTextLayerId", "selectTextLayer", "deselectTextLayer", "setActiveTool", "playbackClock", "compositeToBaseEdited", "baseEditedToComposite", "editedTimeMap", "clipInfo", "seekTo",
  );
  const layers = studioEdits.textLayers;
  const clipDurationSec = editedTimeMap.editedDurationSec;
  const atLayerCap = layers.length >= MAX_TEXT_LAYERS;
  const title = findTitleLayer(layers) ?? null;

  const update = useCallback(
    (id: string, patch: Partial<StudioTextLayer>, gesture?: string) => {
      setStudioEdits((prev) => ({ ...prev, textLayers: patchTextLayer(prev.textLayers, id, patch) }), gesture ? `text-layer-${gesture}-${id}` : undefined);
    },
    [setStudioEdits],
  );
  const updateStyle = useCallback(
    (id: string, patch: Partial<TextLayerStyle>, gesture?: string) => {
      setStudioEdits((prev) => ({ ...prev, textLayers: patchTextLayerStyle(prev.textLayers, id, patch) }), gesture ? `text-layer-style-${gesture}-${id}` : undefined);
    },
    [setStudioEdits],
  );

  /** Selects a layer; from a chip or a list row, seeks to it when it is not on screen. */
  const select = useCallback(
    (id: string, options?: { seek?: boolean }) => {
      selectTextLayer(id);
      if (!options?.seek) return;
      const layer = layers.find((candidate) => candidate.id === id);
      if (!layer) return;
      const now = compositeToBaseEdited(playbackClock.getSnapshot());
      const end = layer.endSec ?? clipDurationSec;
      if (now < layer.startSec || now >= end) seekTo(baseEditedToComposite(layer.startSec));
    },
    [selectTextLayer, layers, compositeToBaseEdited, playbackClock, clipDurationSec, seekTo, baseEditedToComposite],
  );

  const insert = useCallback(
    (layer: StudioTextLayer) => {
      setStudioEdits((prev) => ({ ...prev, textLayers: [...prev.textLayers, layer] }));
      select(layer.id);
      // The new layer starts on screen or at the playhead: show it.
      const now = compositeToBaseEdited(playbackClock.getSnapshot());
      if (now < layer.startSec || now >= (layer.endSec ?? clipDurationSec)) seekTo(baseEditedToComposite(layer.startSec));
    },
    [setStudioEdits, select, compositeToBaseEdited, playbackClock, clipDurationSec, seekTo, baseEditedToComposite],
  );

  /** "Add a title": selects the clip's title when it has one, else adds one from the clip's words. */
  const addTitle = useCallback(
    (style?: TextLayerStyle) => {
      if (title) {
        select(title.id, { seek: true });
        return;
      }
      if (atLayerCap) return;
      insert(newTitleLayer({ id: crypto.randomUUID(), clipTitle: clipInfo.clipTitle, hookText: clipInfo.title, clipDurationSec, settings: DEFAULT_BRAND_TITLE, ...(style ? { style } : {}) }));
    },
    [title, atLayerCap, select, insert, clipInfo.clipTitle, clipInfo.title, clipDurationSec],
  );

  const addBody = useCallback(() => {
    if (atLayerCap) return;
    insert(newBodyLayer({ id: crypto.randomUUID(), playheadSec: compositeToBaseEdited(playbackClock.getSnapshot()), clipDurationSec }));
  }, [atLayerCap, insert, compositeToBaseEdited, playbackClock, clipDurationSec]);

  /** A preset card: restyles the selection, else the title; adds a title in that style when there is neither. */
  const applyPreset = useCallback(
    (preset: TextLayerStyle) => {
      const target = presetTarget(layers, selectedTextLayerId);
      if (target.kind === "add") {
        addTitle(preset);
        return;
      }
      const layer = layers.find((candidate) => candidate.id === target.id)!;
      update(target.id, { style: presetStyleFor(layer, preset) });
      select(target.id, { seek: true });
    },
    [layers, selectedTextLayerId, addTitle, update, select],
  );

  const duplicate = useCallback(
    (id: string) => {
      const layer = layers.find((candidate) => candidate.id === id);
      if (!layer) return;
      if (atLayerCap) {
        toaster.create({ type: "info", title: `A clip holds up to ${MAX_TEXT_LAYERS} text layers`, description: "Delete one to add another." });
        return;
      }
      insert(duplicateTextLayer(layer, crypto.randomUUID()));
    },
    [layers, atLayerCap, insert],
  );

  /** Deletes a layer and returns to Text → Presets. */
  const remove = useCallback(
    (id: string) => {
      setStudioEdits((prev) => ({ ...prev, textLayers: removeTextLayer(prev.textLayers, id) }));
      if (selectedTextLayerId === id) deselectTextLayer();
      setActiveTool("text");
    },
    [setStudioEdits, selectedTextLayerId, deselectTextLayer, setActiveTool],
  );

  /** A canvas gesture's result (place, width, size) as one change. */
  const applyGesture = useCallback(
    (id: string, patch: TextLayerGesturePatch, gesture: TextLayerGesture) => {
      const { fontSize, ...place } = patch;
      setStudioEdits(
        (prev) => ({
          ...prev,
          textLayers: prev.textLayers.map((layer) => (layer.id === id ? { ...layer, ...place, ...(fontSize !== undefined ? { style: { ...layer.style, fontSize } } : {}) } : layer)),
        }),
        `text-layer-canvas-${gesture}-${id}`,
      );
      endCoalesce();
    },
    [setStudioEdits, endCoalesce],
  );

  return { layers, title, atLayerCap, clipDurationSec, selectedId: selectedTextLayerId, update, updateStyle, endCoalesce, select, addTitle, addBody, applyPreset, duplicate, remove, applyGesture };
}

// ─── Canvas ──────────────────────────────────────────────────────────────────

/**
 * Every Text Layer of the target on the preview: one scene painted under the captions (as the
 * export burns it), hit areas for the layers on screen, and the selected layer's frame and toolbar
 * above other canvas objects so its grips stay reachable.
 */
export function StudioTextLayers({
  layers,
  canvas,
  scale,
  currentTime,
  boundsRef,
}: {
  /** The target's text layers from the composition plan (their clamped active ranges). */
  layers: readonly CompositionTextVisualLayer[];
  canvas: { width: number; height: number };
  /** Display px per canvas px. */
  scale: number;
  /** The playhead, the clip's edited timeline. */
  currentTime: number;
  /** The preview area the toolbar stays inside. */
  boundsRef: React.RefObject<HTMLElement | null>;
}) {
  const { playbackClock } = useStudio("playbackClock");
  const { updateStyle, endCoalesce, select, duplicate, remove, applyGesture, selectedId, atLayerCap } = useTextLayerCommands();
  const entries = useMemo(
    () => layers.map((layer) => ({ layer: layer.value, window: { fromMs: Math.round(layer.activeRange.startSec * 1000), toMs: Math.round(layer.activeRange.endSec * 1000) } })),
    [layers],
  );

  return (
    <>
      <TextLayerCanvas
        entries={entries}
        canvas={canvas}
        scale={scale}
        timeSource={playbackClock}
        timeSec={currentTime}
        selectedId={selectedId}
        onSelect={select}
        onCommit={applyGesture}
        onEditText={(id) => {
          select(id);
          requestTextFieldFocus(id);
        }}
        toolbarBoundsRef={boundsRef}
        toolbar={(layer) => (
          <TextLayerToolbar
            style={layer.style}
            onChange={(patch, gesture) => updateStyle(layer.id, patch, gesture ? `toolbar-${gesture}` : undefined)}
            onGestureEnd={endCoalesce}
            onDuplicate={() => duplicate(layer.id)}
            duplicateBlockedReason={atLayerCap ? `A clip holds up to ${MAX_TEXT_LAYERS} text layers. Delete one to add another.` : null}
            onDelete={() => remove(layer.id)}
            {...(layer.role === "title" ? { onApplyToAll: () => requestApplyTitleToAll(layer.id) } : {})}
          />
        )}
      />
      <ApplyTitleToAllHost />
    </>
  );
}

// ─── Apply to all clips ──────────────────────────────────────────────────────

/** The response's counts, read defensively: the title branch answers `{ updated, field, title }` (ticket 05). */
function readApplyTitleResult(body: unknown): ApplyTitleResult {
  const value = (body ?? {}) as { updated?: unknown; title?: { restyled?: unknown; created?: unknown; skipped?: unknown } };
  const count = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : 0);
  const updated = count(value.updated);
  return {
    updated,
    field: "title",
    title: value.title ? { restyled: count(value.title.restyled), created: count(value.title.created), skipped: count(value.title.skipped) } : { restyled: updated, created: 0, skipped: 0 },
  };
}

const actionProps = { h: "40px", px: "4", borderRadius: "10px", fontSize: "14px", fontWeight: "500" } as const;

/** The confirmation and the request for Apply to all clips; one per preview. */
function ApplyTitleToAllHost() {
  const layerId = useSyncExternalStore(applyAllRequest.subscribe, applyAllRequest.get, () => null);
  const { studioEdits, clipInfo } = useStudio("studioEdits", "clipInfo");
  const studioApi = useStudioApi();
  const { openUpgrade } = useUpgrade();
  const [applying, setApplying] = useState(false);
  const layer = layerId ? studioEdits.textLayers.find((candidate) => candidate.id === layerId) : undefined;
  const close = () => applyAllRequest.set(null);

  const apply = async () => {
    if (!layer || applying) return;
    setApplying(true);
    try {
      const api = requireStudioApi(studioApi);
      let body: unknown;
      try {
        const response = await createClipsClient(api.runtime.transport.scoped(api.scope)).projects[":id"].clips["apply-studio-edits"].$post({
          param: { id: clipInfo.projectId },
          json: { patches: [{ title: titlePatchOf(layer) }], excludeClipId: clipInfo.id },
        });
        body = await response.json();
      } catch (error) {
        const upgrade = upgradePromptFromFailure(apiFailureBody(error));
        if (upgrade) openUpgrade(upgrade);
        throw error;
      }
      void invalidateAfterClipChange(api.runtime.queryClient, api.scope, clipInfo.projectId);
      const message = applyTitleResultMessage(readApplyTitleResult(body));
      toaster.create({ type: "success", title: message.title, ...(message.description ? { description: message.description } : {}) });
      close();
    } catch {
      toaster.create({ type: "error", title: "Couldn't apply the title to all clips", description: "No other clip was changed. Try again." });
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog.Root open={Boolean(layer)} onOpenChange={(event) => (event.open ? undefined : close())} placement="center">
      <Portal>
        <Dialog.Backdrop zIndex={300} />
        <Dialog.Positioner zIndex={310}>
          {/* Portaled: mode-invariant studio tokens only. */}
          <Dialog.Content w="min(440px, 92vw)" maxW="min(440px, 92vw)" bg="studio.surface" color="studio.fg" borderRadius="14px" p="6">
            <Flex boxSize="40px" mb="4" align="center" justify="center" borderRadius="full" bg="studio.raised" color="studio.fgMuted" aria-hidden>
              <Layers size={18} />
            </Flex>
            <Stack gap="2">
              <Dialog.Title asChild>
                <Text fontSize="17px" fontWeight="500" letterSpacing="-0.01em">
                  Apply this title to every clip?
                </Text>
              </Dialog.Title>
              <Dialog.Description asChild>
                <Stack gap="2" fontSize="14px" color="studio.fgMuted" lineHeight="1.6">
                  <Text>Every other clip in this project gets this title's style, placement, width and timing. Each clip keeps its own words.</Text>
                  <Text>A clip without a title gets one from its own title.</Text>
                  <Text>Undo in the Studio only covers this clip.</Text>
                </Stack>
              </Dialog.Description>
            </Stack>
            <Flex justify="flex-end" gap="2" mt="6">
              <Dialog.ActionTrigger asChild>
                <Button {...actionProps} bg="studio.raised" color="studio.fg" _hover={{ bg: "studio.borderStrong" }} disabled={applying}>
                  Cancel
                </Button>
              </Dialog.ActionTrigger>
              <Button {...actionProps} colorPalette="brand" onClick={() => void apply()} loading={applying} loadingText="Applying…">
                Apply to all clips
              </Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
