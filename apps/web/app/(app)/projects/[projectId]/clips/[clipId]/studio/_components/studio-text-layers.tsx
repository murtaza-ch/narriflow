"use client";

/**
 * The Studio's Text Layers (title-text spec section 6): the canvas (`TextLayerCanvas` with the
 * floating toolbar) wired to the editor document, the commands the Text panel and the toolbar share,
 * and Apply to all clips for a title. Every gesture and control is one undo step: a continuous change
 * goes through `setStudioEdits` with a coalesce key and ends with `endCoalesce()`.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Dialog, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { Layers } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { toaster } from "@narriflow/ui/components/toaster";
import { type StudioTextLayer, type TextLayerStyle, findTitleLayer } from "@narriflow/validators";
import type { CompositionTextVisualLayer } from "@narriflow/composition-plan";
import { clipQueries, createClipsClient, invalidateAfterClipChange } from "@narriflow/api-client/clips";
import { useQuery } from "@tanstack/react-query";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import { useUpgrade } from "@/app/(app)/_components/upgrade";
import { useStudio } from "./studio-shell";
import { type StudioApi, apiFailureBody, requireStudioApi } from "./studio-api";
import { useStudioApi } from "./use-studio-api";
import { useProjectBrandTitle } from "./project-brand-title";
import { TextLayerCanvas, type TextLayerGesture, type TextLayerGesturePatch } from "./text-layer-canvas";
import { TextLayerToolbar } from "./text-layer-toolbar";
import { PREVIEW_Z } from "./preview-stacking";
import { showTextPanelTab } from "./text-panel-tab";
import {
  type ApplyTitleResult,
  MAX_TEXT_LAYERS,
  applyFailureKind,
  applyTitleResultMessage,
  duplicateTextLayer,
  newBodyLayer,
  newTitleLayer,
  patchTextLayer,
  patchTextLayerStyle,
  presetStyleFor,
  presetTarget,
  removeTextLayer,
  textLayerSeekTarget,
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
 * The Text Layer commands of the open clip. "Add a title" places, times and styles the title from the
 * project's brand title settings (`useProjectBrandTitle`: the built-in default until they load).
 */
export function useTextLayerCommands() {
  const { studioEdits, setStudioEdits, endCoalesce, selectedTextLayerId, selectTextLayer, deselectTextLayer, setActiveTool, playbackClock, compositeToBaseEdited, baseEditedRangeToComposite, editedTimeMap, clipInfo, seekTo } = useStudio(
    "studioEdits", "setStudioEdits", "endCoalesce", "selectedTextLayerId", "selectTextLayer", "deselectTextLayer", "setActiveTool", "playbackClock", "compositeToBaseEdited", "baseEditedRangeToComposite", "editedTimeMap", "clipInfo", "seekTo",
  );
  const brandTitle = useProjectBrandTitle(clipInfo.projectId);
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

  /** Seeks to the layer's first visible frame unless the playhead already shows it (inserted scenes hide it). */
  const show = useCallback(
    (layer: Pick<StudioTextLayer, "startSec" | "endSec">) => {
      const ranges = baseEditedRangeToComposite(layer.startSec, layer.endSec ?? clipDurationSec);
      const target = textLayerSeekTarget(ranges, playbackClock.getSnapshot());
      if (target !== null) seekTo(target);
    },
    [baseEditedRangeToComposite, clipDurationSec, playbackClock, seekTo],
  );

  /**
   * Selects a layer and shows its Settings (`settings: false` keeps the tab, for a preset card);
   * from a chip, a row or a button, `seek` brings it on screen.
   */
  const select = useCallback(
    (id: string, options?: { seek?: boolean; settings?: boolean }) => {
      selectTextLayer(id);
      if (options?.settings !== false) showTextPanelTab("settings");
      if (!options?.seek) return;
      const layer = layers.find((candidate) => candidate.id === id);
      if (layer) show(layer);
    },
    [selectTextLayer, layers, show],
  );

  const insert = useCallback(
    (layer: StudioTextLayer) => {
      setStudioEdits((prev) => ({ ...prev, textLayers: [...prev.textLayers, layer] }));
      select(layer.id);
      // The new layer starts on screen or at the playhead: show it.
      show(layer);
    },
    [setStudioEdits, select, show],
  );

  /** "Add a title": selects the clip's title when it has one, else adds one from the clip's words. */
  const addTitle = useCallback(
    (style?: TextLayerStyle) => {
      if (title) {
        select(title.id, { seek: true });
        return;
      }
      if (atLayerCap) return;
      insert(newTitleLayer({ id: crypto.randomUUID(), clipTitle: clipInfo.clipTitle, hookText: clipInfo.title, clipDurationSec, settings: brandTitle, ...(style ? { style } : {}) }));
    },
    [title, atLayerCap, select, insert, clipInfo.clipTitle, clipInfo.title, clipDurationSec, brandTitle],
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
      // The cards stay in view: the next card can be tried at once.
      select(target.id, { seek: true, settings: false });
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
      showTextPanelTab("presets");
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

  /** An arrow-key nudge: a burst of presses coalesces into one undo step, closed by `endCoalesce` on key up. */
  const nudge = useCallback(
    (id: string, place: { positionX: number; positionY: number }) => {
      setStudioEdits((prev) => ({ ...prev, textLayers: patchTextLayer(prev.textLayers, id, place) }), `text-layer-nudge-${id}`);
    },
    [setStudioEdits],
  );

  return { layers, title, atLayerCap, clipDurationSec, selectedId: selectedTextLayerId, update, updateStyle, endCoalesce, select, addTitle, addBody, applyPreset, duplicate, remove, applyGesture, nudge };
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
  const { updateStyle, endCoalesce, select, duplicate, remove, applyGesture, nudge, selectedId, atLayerCap } = useTextLayerCommands();
  // One entry per plan layer: a layer cut at inserted scenes is several, keyed by the plan's ids.
  const entries = useMemo(
    () => layers.map((layer) => ({ key: layer.id, layer: layer.value, window: { fromMs: Math.round(layer.activeRange.startSec * 1000), toMs: Math.round(layer.activeRange.endSec * 1000) } })),
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
        onNudge={nudge}
        onNudgeEnd={endCoalesce}
        zIndex={{ paint: PREVIEW_Z.text, frame: PREVIEW_Z.textFrame }}
        onEditText={(id) => {
          select(id);
          requestTextFieldFocus(id);
        }}
        toolbarBoundsRef={boundsRef}
        toolbar={(layer, { compact }) => (
          <TextLayerToolbar
            compact={compact}
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
  const [status, setStatus] = useState<ApplyTitleStatus>("idle");
  const layer = layerId ? studioEdits.textLayers.find((candidate) => candidate.id === layerId) : undefined;
  const open = Boolean(layer);
  // How many other clips the project has (read while the confirmation is open): a one-clip project has nothing to apply to.
  const [otherClips, setOtherClips] = useState<number | null>(null);
  const close = () => {
    applyAllRequest.set(null);
    setStatus("idle");
    setOtherClips(null);
  };

  const apply = async () => {
    if (!layer || status === "applying") return;
    setStatus("applying");
    try {
      const api = requireStudioApi(studioApi);
      const response = await createClipsClient(api.runtime.transport.scoped(api.scope)).projects[":id"].clips["apply-studio-edits"].$post({
        param: { id: clipInfo.projectId },
        json: { patches: [{ title: titlePatchOf(layer) }], excludeClipId: clipInfo.id },
      });
      const body = await response.json();
      void invalidateAfterClipChange(api.runtime.queryClient, api.scope, clipInfo.projectId);
      const message = applyTitleResultMessage(readApplyTitleResult(body));
      toaster.create({ type: "success", title: message.title, description: message.description });
      close();
    } catch (error) {
      const kind = applyFailureKind(error);
      if (kind === "refused") {
        const upgrade = upgradePromptFromFailure(apiFailureBody(error));
        if (upgrade) openUpgrade(upgrade);
      }
      setStatus(kind);
    }
  };

  const copy = applyTitleDialogCopy({ otherClips, status });
  return (
    <Dialog.Root open={open} onOpenChange={(event) => (event.open ? undefined : close())} placement="center">
      {open && studioApi ? <OtherClipCount api={studioApi} projectId={clipInfo.projectId} clipId={clipInfo.id} onCount={setOtherClips} /> : null}
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
                  {copy.title}
                </Text>
              </Dialog.Title>
              <Dialog.Description asChild>
                <Stack gap="2" fontSize="14px" color="studio.fgMuted" lineHeight="1.6">
                  {copy.lines.map((line) => (
                    <Text key={line}>{line}</Text>
                  ))}
                </Stack>
              </Dialog.Description>
              {copy.status ? (
                <Text role="alert" fontSize="13.5px" color="studio.fg" bg="studio.raised" borderRadius="10px" px="3" py="2.5" lineHeight="1.5">
                  {copy.status}
                </Text>
              ) : null}
            </Stack>
            <Flex justify="flex-end" gap="2" mt="6">
              <Dialog.ActionTrigger asChild>
                <Button {...actionProps} bg="studio.raised" color="studio.fg" _hover={{ bg: "studio.borderStrong" }} disabled={status === "applying"}>
                  {copy.confirm ? "Cancel" : "Close"}
                </Button>
              </Dialog.ActionTrigger>
              {copy.confirm ? (
                <Button {...actionProps} colorPalette="brand" onClick={() => void apply()} loading={status === "applying"} loadingText="Applying…">
                  {copy.confirm}
                </Button>
              ) : null}
            </Flex>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** Reads the project's clips and reports how many there are besides this one. Renders nothing. */
function OtherClipCount({ api, projectId, clipId, onCount }: { api: StudioApi; projectId: string; clipId: string; onCount: (count: number) => void }) {
  const list = useQuery(clipQueries.list(createClipsClient(api.runtime.transport.scoped(api.scope)), api.scope, projectId));
  const count = list.data ? list.data.clips.filter((clip) => clip.id !== clipId).length : null;
  useEffect(() => {
    if (count !== null) onCount(count);
  }, [count, onCount]);
  return null;
}

export type ApplyTitleStatus = "idle" | "applying" | "refused" | "unknown";

/**
 * What the Apply-to-all confirmation says. A project with no other clip says so and offers no
 * action; a refusal says nothing changed; a lost answer says the outcome is unknown and offers to
 * try again (applying twice gives the same titles).
 */
export function applyTitleDialogCopy({ otherClips, status }: { otherClips: number | null; status: ApplyTitleStatus }): { title: string; lines: string[]; status: string | null; confirm: string | null } {
  if (otherClips === 0) {
    return { title: "No other clips in this project", lines: ["This project has only this clip, so there is nowhere else to apply the title. Clips you generate later get their title from the brand kit."], status: null, confirm: null };
  }
  const lines = [
    "Every other clip in this project gets this title's style, placement, width and timing. Each clip keeps its own words.",
    "A clip without a title gets one from its own title.",
    "Undo in the Studio only covers this clip.",
  ];
  if (status === "refused") return { title: "Apply this title to every clip?", lines, status: "Couldn't apply the title. No other clip was changed.", confirm: "Try again" };
  if (status === "unknown") return { title: "Apply this title to every clip?", lines, status: "Couldn't confirm the change: the answer didn't arrive, so some clips may have changed. Try again to make sure every clip matches.", confirm: "Try again" };
  return { title: "Apply this title to every clip?", lines, status: null, confirm: "Apply to all clips" };
}
