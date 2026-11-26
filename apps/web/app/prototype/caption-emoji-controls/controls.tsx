"use client";

// Emoji controls harness (Add Emojis ticket 09): the real Emojis section, word chips, transcript
// line chips and picker over a fixture clip, with local undo history and a stubbed suggest call.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, ColorPicker, Flex, HStack, Portal, Text, parseColor } from "@chakra-ui/react";
import { Combine, Plus, Trash2 } from "lucide-react";
import { useColorMode } from "@narriflow/ui/components/color-mode";
import {
  buildEditedTimeMap,
  captionTextDirection,
  captionWordKey,
  replaceCaptionEmojis,
  withCaptionEmojis,
  type CaptionEmojiDensity,
  type CaptionEmojiRef,
  type CaptionPreset,
  type EditorDocument,
} from "@narriflow/validators";
import { createCaptionEmojiLines } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/caption-emoji-lines";
import type { CaptionEmojiAnswer } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/caption-emoji-runs";
import { captionEmojiWords, typedEmojiCueRanges } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/caption-emoji-words";
import { EMOJI_FIXTURE_WORD_IDS, emojiFixtureDocument, emojiFixtureLayersFor } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/caption-emoji-fixture";
import { LineEmojiChips } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/emoji-chips";
import { CaptionEmojiPickerHost } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/emoji-picker-host";
import { EmojisSection } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/emojis-section";
import { useCaptionEmojiEditor } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/use-caption-emojis";
import { ReadOnlyPanelNotice } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-sidebar";

export interface HarnessOptions {
  readonly presetId: string;
  readonly rtl: boolean;
  readonly state: "off" | "none" | "some" | "mixed" | "nowords" | "readonly" | "hidden";
  /** The first line in Arabic around an English name (mixed-direction chips). */
  readonly mixedScript: boolean;
  readonly suggest: "ok" | "empty" | "error" | "offline" | "hang" | "partial" | "unsaved";
  readonly timeSec: number;
  readonly open: "live" | "line" | "last" | "add" | null;
  readonly search: string | null;
  readonly tone: number | null;
  readonly run: boolean;
  /** Removes one emoji by hand, then presses Regenerate (the confirm). */
  readonly confirm: boolean;
  readonly mode: "light" | "dark" | null;
}


function createClock(initial: number) {
  let time = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => time,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (sec: number) => {
      time = sec;
      for (const listener of listeners) listener();
    },
  };
}

/** Line 0 as "مرحبا New York الآن ..." with a city skyline on its third word (York). */
function withMixedScript(document: EditorDocument): EditorDocument {
  const texts = ["مرحبا", "New", "York", "الآن", "نبدأ", "من", "جديد", "اليوم."];
  const transcriptSlice = document.transcriptSlice.map((line, at) => {
    if (at !== 0) return line;
    const words = line.words.map((word, index) => ({ ...word, word: texts[index] ?? word.word }));
    return { ...line, words, text: words.map((word) => word.word).join(" ") };
  });
  const lineEmojis = new Set(document.transcriptSlice[0]!.words.map((word) => captionWordKey(word.startSec)));
  const kept = Object.entries(document.studioEdits.captionEmojis ?? {}).filter(([key]) => !lineEmojis.has(key));
  const york = captionWordKey(transcriptSlice[0]!.words[2]!.startSec);
  return { ...document, transcriptSlice, studioEdits: replaceCaptionEmojis(document.studioEdits, Object.fromEntries([...kept, [york, { id: "city-skyline" }]]))! };
}

/** Stored emojis that do not draw: one on a cut word (idea), one in a cue whose text has a typed emoji (team). */
function withHiddenEmojis(document: EditorDocument): EditorDocument {
  const idea = document.transcriptSlice[0]!.words[2]!;
  const transcriptSlice = document.transcriptSlice.map((line, at) =>
    at === 2 ? { ...line, words: line.words.map((word, index) => (index === 1 ? { ...word, word: "whole🔥" } : word)), text: line.text.replace("whole", "whole🔥") } : line,
  );
  return { ...document, transcriptSlice, deletedRanges: [{ startSec: idea.startSec - 0.01, endSec: idea.endSec + 0.01 }] };
}

function initialDocument(options: HarnessOptions): EditorDocument {
  const fixture = emojiFixtureDocument({ presetId: options.presetId, rtl: options.rtl });
  const document = options.state === "hidden" ? withHiddenEmojis(fixture) : options.mixedScript ? withMixedScript(fixture) : fixture;
  const preset = { ...document.captionPreset, emojis: options.state !== "off", ...(options.tone ? { emojiTone: options.tone } : {}) };
  if (options.state === "nowords") return { ...document, captionPreset: preset, transcriptSlice: [], studioEdits: replaceCaptionEmojis(document.studioEdits, {})! };
  if (options.state === "none" || options.state === "off") return { ...document, captionPreset: preset, studioEdits: replaceCaptionEmojis(document.studioEdits, {})! };
  if (options.state === "mixed") {
    // Every other line loses its emojis: rows with and without one, side by side.
    const keep = Object.entries(document.studioEdits.captionEmojis ?? {}).filter(([key]) => {
      const line = document.transcriptSlice.findIndex((candidate) => candidate.words.some((word) => captionWordKey(word.startSec) === key));
      return line % 2 === 0;
    });
    return { ...document, captionPreset: preset, studioEdits: replaceCaptionEmojis(document.studioEdits, Object.fromEntries(keep))! };
  }
  return { ...document, captionPreset: preset };
}

/** The harness's AI: each line's last hand-chosen word with its fitting emoji, after a realistic wait (`partial`: the first half of the lines, marked incomplete). */
function stubSuggest(document: EditorDocument, answer: HarnessOptions["suggest"]): Promise<CaptionEmojiAnswer> {
  return new Promise((resolve, reject) => {
    if (answer === "hang") return;
    setTimeout(() => {
      if (answer === "error") return reject({ code: "openai_rate_limited" });
      if (answer === "offline") return reject({ code: null });
      if (answer === "empty") return resolve({ emojis: {} });
      const picks: Record<string, CaptionEmojiRef> = {};
      const lines = answer === "partial" ? document.transcriptSlice.slice(0, Math.ceil(document.transcriptSlice.length / 2)) : document.transcriptSlice;
      lines.forEach((line) => {
        const word = [...line.words].reverse().find((candidate) => EMOJI_FIXTURE_WORD_IDS.has(candidate.word));
        if (word) picks[captionWordKey(word.startSec)] = { id: EMOJI_FIXTURE_WORD_IDS.get(word.word)! };
      });
      resolve({ emojis: picks, complete: answer !== "partial" });
    }, 1800);
  });
}

/** The Captions panel's colour control, as `captions-panel.tsx` draws it. */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  return (
    <Box minW="0">
      <ColorPicker.Root value={parseColor(value)} onValueChange={(e) => onChange(e.value.toString("hex"))} size="xs">
        <ColorPicker.HiddenInput />
        <ColorPicker.Control>
          <ColorPicker.Trigger w="100%" h="40px" borderRadius="10px" borderWidth="0" bg="studio.subtle" cursor="pointer" p="5px" aria-label={`${label} color`}>
            <ColorPicker.ValueSwatch w="100%" h="100%" borderRadius="6px" />
          </ColorPicker.Trigger>
        </ColorPicker.Control>
        <Portal>
          <ColorPicker.Positioner>
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
      <Text fontSize="12px" color="studio.fgMuted" mt="6px">
        {label}
      </Text>
    </Box>
  );
}

/** The transcript row's hover actions (`transcript-panel.tsx` `LineAction`), inert here, so chips sit where they sit in the Studio. */
function LineActionsStandIn() {
  return (
    <Flex data-line-actions align="center" gap="1px" color="studio.fgSubtle" aria-hidden>
      {[Plus, Combine, Trash2].map((Icon, at) => (
        <Flex key={at} w="28px" h="28px" align="center" justify="center">
          <Icon size={15} />
        </Flex>
      ))}
    </Flex>
  );
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function CaptionEmojiControlsHarness({ options }: { options: HarnessOptions }) {
  const { setColorMode } = useColorMode();
  useEffect(() => {
    if (options.mode) setColorMode(options.mode);
  }, [options.mode, setColorMode]);

  const [history, setHistory] = useState(() => [initialDocument(options)]);
  const document = history.at(-1)!;
  // The latest document outside render, so a write can return what it committed (as the Studio's session does).
  const latest = useRef(document);
  latest.current = document;
  const commit = (next: EditorDocument) => {
    if (next === latest.current) return;
    latest.current = next;
    setHistory((previous) => [...previous, next]);
  };
  const [clock] = useState(() => createClock(options.timeSec));
  const [timeSec, setTimeSec] = useState(options.timeSec);
  const layers = useMemo(() => emojiFixtureLayersFor(document, { rtl: options.rtl }), [document, options.rtl]);
  const model = useMemo(() => captionEmojiWords(document, buildEditedTimeMap(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec })), [document]);

  const editor = useCaptionEmojiEditor({
    clipId: `harness-${options.presetId}-${options.state}`,
    preset: document.captionPreset,
    entries: document.studioEdits.captionEmojis,
    model,
    readOnly: options.state === "readonly",
    updatePreset: (patch: Partial<CaptionPreset>) => commit({ ...document, captionPreset: { ...document.captionPreset, ...patch } }),
    setEmojis: (entries) => {
      const studioEdits = withCaptionEmojis(latest.current.studioEdits, entries);
      if (studioEdits) commit({ ...latest.current, studioEdits });
    },
    replaceEmojis: (value) => {
      const studioEdits = replaceCaptionEmojis(latest.current.studioEdits, value);
      if (studioEdits) commit({ ...latest.current, studioEdits });
      return latest.current.studioEdits.captionEmojis;
    },
    save: async () => options.suggest !== "unsaved",
    suggest: (_density: CaptionEmojiDensity) => stubSuggest(latest.current, options.suggest),
    failureCode: (error) => (error as { code: string | null }).code,
  });
  const live = useMemo(() => ({ clock, layers, toBaseEdited: (sec: number) => sec }), [clock, layers]);
  const [lines] = useState(createCaptionEmojiLines);
  const typedEmojiCues = useMemo(() => typedEmojiCueRanges(layers, (sec) => sec), [layers]);
  lines.set({
    editor,
    addContext: () => ({ playheadSec: clock.getSnapshot(), heroKeys: new Set() }),
    seek: (sec) => {
      setTimeSec(sec);
      clock.set(sec);
    },
    typedEmojiCues,
  });
  useLayoutEffect(() => lines.notify());

  useEffect(() => {
    const timers: number[] = [];
    const later = (ms: number, run: () => void) => timers.push(window.setTimeout(run, ms));
    if (options.confirm) {
      later(500, () => window.document.querySelector<HTMLElement>('[aria-label^="Remove "]')?.click());
      later(800, () => [...window.document.querySelectorAll("button")].find((button) => button.textContent?.includes("Regenerate"))?.click());
    }
    if (options.run) later(600, () => [...window.document.querySelectorAll("button")].find((button) => /Add with AI|Regenerate/.test(button.textContent ?? ""))?.click());
    // Regenerate over emojis loaded with the page asks first; `run` answers Replace.
    if (options.run) later(900, () => [...window.document.querySelectorAll("button")].find((button) => button.textContent === "Replace")?.click());
    const selector = { live: '[aria-label="Words on screen now"] button', line: '[aria-label="Emojis on this line"] button[aria-haspopup]', last: '[aria-label="Emojis on this line"] button[aria-haspopup]', add: '[aria-label="Add emoji to this line"]' }[options.open ?? "live"];
    // `add` prefers a line whose add button is always shown over a row hover action; `last` is the last line's chip.
    const target = () =>
      (options.open === "add" && window.document.querySelector<HTMLElement>(`${selector}:not([data-line-actions])`)) ||
      (options.open === "last" ? [...window.document.querySelectorAll<HTMLElement>(selector)].at(-1) : null) ||
      window.document.querySelector<HTMLElement>(selector);
    if (options.open) later(900, () => target()?.click());
    if (options.open && options.search) later(2200, () => {
      const input = window.document.querySelector<HTMLInputElement>('[aria-label="Search emojis"]');
      if (input) setInputValue(input, options.search!);
    });
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [options]);

  const duration = layers.at(-1)?.activeRange.endSec ?? 10;
  return (
    // The page follows the app's color mode; the Studio area is pinned graphite exactly as
    // `studio/layout.tsx` pins it, so portaled overlays see the same modes they see in the Studio.
    <Box minH="100dvh" bg="bg" p="3">
      <Flex className="dark" data-theme="dark" gap="2" align="flex-start" justify="center" bg="studio.frame" color="studio.fg" p="2" borderRadius="16px" w="fit-content" mx="auto">
        <Box w="420px" bg="studio.canvas" borderRadius="12px" py="2" flexShrink={0}>
          <Flex px="5" py="3" align="center" justify="space-between">
            <Text fontSize="14px" fontWeight="500">Edit subtitles</Text>
            <Box as="button" fontSize="12px" color="studio.fgMuted" aria-disabled={history.length < 2} onClick={() => setHistory((previous) => (previous.length > 1 ? previous.slice(0, -1) : previous))}>
              Undo ({history.length - 1})
            </Box>
          </Flex>
          {document.transcriptSlice.map((line, index) => (
            <Box
              key={`${line.index}-${line.startSec}`}
              px="20px"
              py="10px"
              css={{ "& [data-line-actions]": { opacity: 0, transition: "opacity 120ms ease" }, "&:hover [data-line-actions], &:focus-within [data-line-actions]": { opacity: 1 } }}
            >
              <Flex align="center" justify="space-between" gap="2" minH="28px">
                <Text textStyle="data" fontSize="11px" color="studio.timecode">
                  {line.startSec.toFixed(2)}–{line.endSec.toFixed(2)}
                </Text>
                <LineEmojiChips store={lines} lines={[index]} direction={captionTextDirection(line.text)} />
                <LineActionsStandIn />
              </Flex>
              <Text fontSize="14px" lineHeight="1.7" py="6px" dir={captionTextDirection(line.text)}>
                {line.text}
              </Text>
            </Box>
          ))}
        </Box>
        <Box w="380px" bg="studio.canvas" borderRadius="12px" flexShrink={0}>
          <Text px="5" pt="4" pb="3" fontSize="16px" fontWeight="500">
            Captions
          </Text>
          {options.state === "readonly" ? <ReadOnlyPanelNotice onTakeOver={() => undefined} /> : null}
          <Flex px="5" pb="2" gap="3" align="center">
            <Text fontSize="11px" color="studio.timecode" fontVariantNumeric="tabular-nums" w="44px">
              {timeSec.toFixed(2)}s
            </Text>
            <input
              type="range"
              aria-label="Playhead"
              min={0}
              max={duration}
              step={0.01}
              value={timeSec}
              style={{ flex: 1 }}
              onChange={(event) => {
                setTimeSec(Number(event.target.value));
                clock.set(Number(event.target.value));
              }}
            />
          </Flex>
          <Box px="5" pt="4" pb="6">
            <EmojisSection editor={editor} live={live} ColourField={ColorField} />
          </Box>
        </Box>
      </Flex>
      <CaptionEmojiPickerHost />
    </Box>
  );
}
