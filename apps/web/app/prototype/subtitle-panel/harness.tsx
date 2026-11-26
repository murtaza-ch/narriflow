"use client";

// Subtitle panel harness (Add Emojis ticket 22): the Studio's real transcript panel over a fixture
// document held in local state, with a fake playhead and the Studio's own edit functions. No API.
import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { planClipComposition, type CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
  applyEditorAction,
  buildEditedTimeMap,
  replaceCaptionEmojis,
  withCaptionEmojis,
  type EditorAction,
  type EditorDocument,
} from "@narriflow/validators";
import { SignedOutApiProvider } from "@/app/_components/api-provider";
import { StudioFieldsProvider, type StudioFields } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell";
import { CaptionEmojiPickerHost } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/emoji-picker-host";
import { replaceSubtitleParagraphText, type CaptionRowAddress } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/subtitle-lines";
import { captionRowCommandActions, type CaptionRowCommand } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/subtitle-row-commands";
import { transcriptFixtureDocument } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/transcript/transcript-fixture";
import { TranscriptPanel } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/transcript/transcript-panel";

export interface SubtitlePanelOptions {
  readonly view: "sentence" | "paragraph" | "word";
  readonly emojis: "none" | "some" | "two" | "off";
  readonly rtl: boolean;
  readonly readOnly: boolean;
  readonly presetId: string;
  readonly seconds: number;
  readonly timeSec: number;
  readonly play: boolean;
  readonly search: string | null;
  readonly focus: string | null;
}

function createClock(initial: number) {
  let time = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => time,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (sec: number) => {
      time = sec;
      for (const listener of [...listeners]) listener();
    },
  };
}

function captionLayersFor(document: EditorDocument): CompositionCaptionVisualLayer[] {
  const result = planClipComposition({
    document, source: { identity: "source:subtitle-panel", kind: "video", width: 1920, height: 1080, hasAudio: true },
    evidence: { automaticLayout: { state: "missing" } }, assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") return [];
  return result.plan.targets[0]!.visualLayers.flatMap((layer) => (layer.kind === "caption" ? [layer] : []));
}

const noop = () => undefined;

/** Client only: the fixture and fake clock have no server rendering to match. */
export function SubtitlePanelHarness({ options }: { options: SubtitlePanelOptions }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Harness options={options} /> : null;
}

function Harness({ options }: { options: SubtitlePanelOptions }) {
  const [history, setHistory] = useState<EditorDocument[]>(() => [
    transcriptFixtureDocument({
      presetId: options.presetId,
      rtl: options.rtl,
      seconds: options.rtl ? undefined : options.seconds,
      emojis: options.emojis === "off" ? "some" : options.emojis,
      emojisOn: options.emojis !== "off",
    }),
  ]);
  const document = history.at(-1)!;
  const latest = useRef(document);
  latest.current = document;
  const [clock] = useState(() => createClock(options.timeSec));
  const [timeSec, setTimeSec] = useState(options.timeSec);
  const editedTimeMap = useMemo(() => buildEditedTimeMap(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec }), [document]);
  const captionLayers = useMemo(() => captionLayersFor(document), [document]);
  const duration = editedTimeMap.editedDurationSec;

  // Stable across renders, as the Studio's callbacks are: a new function would re-render every row.
  const edits = useMemo(() => {
    const seek = (sec: number) => {
      clock.set(sec);
      setTimeSec(sec);
    };
    const apply = (actions: readonly EditorAction[]) => {
      if (actions.length === 0) return;
      const next = actions.reduce(applyEditorAction, latest.current);
      if (next !== latest.current) setHistory((previous) => [...previous, next]);
    };
    const rowCommand = (command: CaptionRowCommand) => apply(captionRowCommandActions(latest.current, command));
    return {
      baseEditedToComposite: (sec: number) => sec,
      compositeToBaseEdited: (sec: number) => sec,
      seekTo: seek,
      setActiveTool: noop,
      editCaptionRow: (row: CaptionRowAddress, text: string) => rowCommand({ type: "edit", row, text }),
      addCaptionRowAfter: (row: CaptionRowAddress) => rowCommand({ type: "add-after", row }),
      deleteCaptionRow: (row: CaptionRowAddress) => rowCommand({ type: "delete", row }),
      mergeCaptionRowWithNext: (row: CaptionRowAddress, next: CaptionRowAddress) => rowCommand({ type: "merge-next", row, next }),
      updateParagraphText: (indices: number[], text: string) =>
        apply([{ type: "setTranscriptSlice", transcriptSlice: replaceSubtitleParagraphText(latest.current.transcriptSlice, indices, text) }]),
      updateWord: (utteranceIndex: number, wordIndex: number, text: string) => apply([{ type: "updateWordText", utteranceIndex, wordIndex, text }]),
      deleteSourceRange: (range: { startSec: number; endSec: number }) => {
        apply([{ type: "deleteRange", range }]);
        return true;
      },
      revertDeletedRange: (range: { startSec: number; endSec: number }) => apply([{ type: "revertRange", range }]),
      setTranscriptSelectionRange: noop,
      insertSceneBlock: noop,
      sceneWriteCapabilities: { cards: false },
      sceneFonts: [],
      upgradePrompts: {},
      leaveStudio: noop,
      setCaptionPreset: (update: (previous: EditorDocument["captionPreset"]) => EditorDocument["captionPreset"]) =>
        apply([{ type: "setCaptionPreset", captionPreset: update(latest.current.captionPreset) }]),
      setCaptionEmojis: (entries: Parameters<typeof withCaptionEmojis>[1]) => {
        const studioEdits = withCaptionEmojis(latest.current.studioEdits, entries);
        if (studioEdits) apply([{ type: "setStudioEdits", studioEdits }]);
      },
      replaceCaptionEmojis: (value: Parameters<typeof replaceCaptionEmojis>[1]) => {
        const studioEdits = replaceCaptionEmojis(latest.current.studioEdits, value);
        if (studioEdits) apply([{ type: "setStudioEdits", studioEdits }]);
        return latest.current.studioEdits.captionEmojis;
      },
      checkpointCloud: async () => true,
    };
  }, [clock]);
  const seek = edits.seekTo;
  useEffect(() => {
    if (!options.play) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = clock.getSnapshot() + (now - last) / 1000;
      last = now;
      clock.set(next > duration ? 0 : next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [clock, duration, options.play]);

  const fields = {
    clipInfo: { id: "clip-subtitle-panel", projectId: "project-subtitle-panel", captionLanguage: options.rtl ? "ur" : "en" },
    editorDocument: document,
    utterances: document.transcriptSlice,
    captionPreset: document.captionPreset,
    studioEdits: document.studioEdits,
    duration,
    clipStartSec: document.clipStartSec,
    editedTimeMap,
    deletedRanges: document.deletedRanges,
    playbackClock: clock,
    captionLayers,
    editingElsewhere: options.readOnly,
    ...edits,
  } as unknown as StudioFields;

  useEffect(() => {
    if (!options.search) return;
    const timer = window.setTimeout(() => {
      const input = window.document.querySelector<HTMLInputElement>('[aria-label="Search captions"]');
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, options.search);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [options.search]);

  useEffect(() => {
    if (!options.focus) return;
    const timer = window.setTimeout(() => {
      window.document.querySelector<HTMLElement>(`button[aria-label*="emoji on “${options.focus}”"]`)?.focus();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [options.focus]);

  return (
    <SignedOutApiProvider>
      <StudioFieldsProvider fields={fields}>
        <Box minH="100dvh" bg="bg" p="3">
          <Flex className="dark" data-theme="dark" gap="2" h="calc(100dvh - 24px)" bg="studio.frame" color="studio.fg" p="2" borderRadius="16px" w="fit-content" mx="auto">
            <Flex direction="column" w="420px" h="full">
              <TranscriptPanel initialView={options.view} />
            </Flex>
            <Flex direction="column" w="260px" bg="studio.canvas" borderRadius="12px" p="4" gap="3">
              <Text fontSize="13px" color="studio.fgMuted">
                Playhead
              </Text>
              <Text fontSize="20px" fontVariantNumeric="tabular-nums">
                {timeSec.toFixed(2)}s
              </Text>
              <input type="range" aria-label="Playhead" min={0} max={duration} step={0.01} value={timeSec} onChange={(event) => seek(Number(event.target.value))} />
              <Box
                as="button"
                fontSize="12px"
                color="studio.fgMuted"
                textAlign="start"
                aria-disabled={history.length < 2}
                onClick={() => setHistory((previous) => (previous.length > 1 ? previous.slice(0, -1) : previous))}
              >
                Undo ({history.length - 1})
              </Box>
            </Flex>
          </Flex>
          <CaptionEmojiPickerHost />
        </Box>
      </StudioFieldsProvider>
    </SignedOutApiProvider>
  );
}
