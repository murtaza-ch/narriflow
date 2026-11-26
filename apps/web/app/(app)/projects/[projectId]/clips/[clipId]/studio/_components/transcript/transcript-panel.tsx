"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Box } from "@chakra-ui/react";
import { getSourceLanguageLabel, sourceLanguageCodeSchema } from "@narriflow/validators";
import { useStudio } from "../studio-shell";
import { StudioCaptionEmojiLines, StudioParagraphEmojis, StudioRowEmojiButtons } from "../emoji/studio-caption-emojis";
import { CaptionRowList, type CaptionRowActions, type RowEmojiSlot } from "./caption-rows";
import { ParagraphRowList, type ParagraphEmojiSlot, type ParagraphRowActions } from "./paragraph-rows";
import { TranscriptHeader, type TranscriptViewMode } from "./transcript-header";
import { captionRows, paragraphRows, type CaptionRowModel, type ParagraphRowModel } from "./transcript-rows";
import { filterRows, normalizeSearchQuery } from "./transcript-search";
import { useActiveRow, useFollowActiveRow } from "./use-active-row";
import { WordView } from "./word-view";

// The Studio's transcript panel, after Vizard's "Edit subtitles": Sentence lists one row per caption
// on the video, Paragraph groups utterances under their start times, Word shows running text for
// cutting. No speaker labels: speakers still drive layouts and caption styles.

const captionEmoji: RowEmojiSlot = (row, direction) => <StudioRowEmojiButtons spans={row.spans} direction={direction} />;
const paragraphEmoji: ParagraphEmojiSlot = (row, direction, part) => <StudioParagraphEmojis spans={row.spans} direction={direction} part={part} />;

/** A gap between captions shorter than this keeps the caption before it highlighted. */
const CAPTION_GAP_HOLD_SEC = 1;

/** The caption rows of the current document, kept as the same objects where unchanged. */
function useCaptionRows(language: string | null): readonly CaptionRowModel[] {
  const { editorDocument } = useStudio("editorDocument");
  const previous = useRef<CaptionRowModel[]>([]);
  const { transcriptSlice, deletedRanges, sceneBlocks, captionPreset, censorSegments, clipStartSec, clipEndSec, studioEdits } = editorDocument;
  const merges = studioEdits.captionMerges;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the grouping reads only these fields; emoji and other edits leave the rows alone.
  return useMemo(() => {
    previous.current = captionRows(editorDocument, language, previous.current);
    return previous.current;
  }, [transcriptSlice, deletedRanges, sceneBlocks, captionPreset, censorSegments, clipStartSec, clipEndSec, merges, language]);
}

interface ViewProps<Row> {
  readonly rows: readonly Row[];
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly readOnly: boolean;
  readonly language: string | null;
  readonly query: string;
}

function SentenceView({ rows, scrollRef, readOnly, language, query }: ViewProps<CaptionRowModel>) {
  const { playbackClock, seekTo, editCaptionRow, addCaptionRowAfter, deleteCaptionRow, mergeCaptionRowWithNext } = useStudio(
    "playbackClock",
    "seekTo",
    "editCaptionRow",
    "addCaptionRowAfter",
    "deleteCaptionRow",
    "mergeCaptionRowWithNext",
  );
  const active = rows[useActiveRow(playbackClock, rows, CAPTION_GAP_HOLD_SEC)]?.id ?? null;
  useFollowActiveRow(scrollRef, active);
  const actions = useMemo<CaptionRowActions>(
    () => ({ seek: seekTo, edit: editCaptionRow, addAfter: addCaptionRowAfter, remove: deleteCaptionRow, mergeNext: mergeCaptionRowWithNext }),
    [seekTo, editCaptionRow, addCaptionRowAfter, deleteCaptionRow, mergeCaptionRowWithNext],
  );
  return <CaptionRowList rows={rows} active={active} readOnly={readOnly} language={language} query={query} actions={actions} emoji={captionEmoji} />;
}

function ParagraphView({ rows, scrollRef, readOnly, language, query }: ViewProps<ParagraphRowModel>) {
  const { playbackClock, seekTo, updateParagraphText } = useStudio("playbackClock", "seekTo", "updateParagraphText");
  const active = rows[useActiveRow(playbackClock, rows)]?.id ?? null;
  useFollowActiveRow(scrollRef, active);
  const actions = useMemo<ParagraphRowActions>(
    () => ({ seek: seekTo, edit: (lines, text) => updateParagraphText([...lines], text) }),
    [seekTo, updateParagraphText],
  );
  return <ParagraphRowList rows={rows} active={active} readOnly={readOnly} language={language} query={query} actions={actions} emoji={paragraphEmoji} />;
}

export function TranscriptPanel({ initialView = "sentence" }: { initialView?: TranscriptViewMode }) {
  const { clipInfo, editorDocument, duration, editingElsewhere, seekTo, setActiveTool } = useStudio(
    "clipInfo",
    "editorDocument",
    "duration",
    "editingElsewhere",
    "seekTo",
    "setActiveTool",
  );
  const language = clipInfo.captionLanguage;
  // The language the transcript was detected (or chosen) in, when it is one the catalog names.
  const spokenLanguageCode = sourceLanguageCodeSchema.safeParse(language);
  const languageLabel = spokenLanguageCode.success && spokenLanguageCode.data ? getSourceLanguageLabel(spokenLanguageCode.data) : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<TranscriptViewMode>(initialView);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(-1);
  const query = normalizeSearchQuery(search);

  const captions = useCaptionRows(language);
  const paragraphsPrevious = useRef<ParagraphRowModel[]>([]);
  const paragraphs = useMemo(() => {
    if (view !== "paragraph") return paragraphsPrevious.current;
    paragraphsPrevious.current = paragraphRows(editorDocument, captions, duration, paragraphsPrevious.current);
    return paragraphsPrevious.current;
  }, [view, editorDocument, captions, duration]);
  const shownCaptions = useMemo(() => filterRows(captions, query), [captions, query]);
  const shownParagraphs = useMemo(() => filterRows(paragraphs, query), [paragraphs, query]);
  const shown: readonly { id: string; startSec: number }[] = view === "paragraph" ? shownParagraphs : shownCaptions;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query or view starts the Enter walk over.
  useEffect(() => setCursor(-1), [query, view]);

  const onNext = useCallback(() => {
    if (shown.length === 0) return;
    const next = (cursor + 1) % shown.length;
    setCursor(next);
    const row = shown[next]!;
    seekTo(row.startSec);
    scrollRef.current?.querySelector(`[data-row-key="${CSS.escape(row.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [cursor, seekTo, shown]);

  const onViewChange = useCallback((mode: TranscriptViewMode) => {
    window.getSelection()?.removeAllRanges();
    setView(mode);
  }, []);

  return (
    <Box
      w="clamp(320px, 26vw, 480px)"
      flexShrink={0}
      h="100%"
      bg="studio.canvas"
      borderRadius="12px"
      display={{ base: "none", lg: "flex" }}
      flexDirection="column"
      overflow="hidden"
    >
      <TranscriptHeader
        view={view}
        onViewChange={onViewChange}
        languageLabel={languageLabel}
        search={view === "word" ? null : { value: search, matches: shown.length, cursor, onChange: setSearch, onNext }}
        onAutoCensor={() => setActiveTool("censor")}
      />
      <Box
        ref={scrollRef}
        flex="1"
        overflowY="auto"
        overflowX="hidden"
        position="relative"
        py="4px"
        css={{
          "&::-webkit-scrollbar": { width: "4px" },
          "&::-webkit-scrollbar-track": { background: "transparent" },
          "&::-webkit-scrollbar-thumb": { background: "var(--chakra-colors-studio-raised)", borderRadius: "4px" },
        }}
      >
        {view === "word" ? (
          <WordView scrollRef={scrollRef} />
        ) : (
          <StudioCaptionEmojiLines>
            {view === "sentence" ? (
              <SentenceView rows={shownCaptions} scrollRef={scrollRef} readOnly={editingElsewhere} language={language} query={query} />
            ) : (
              <ParagraphView rows={shownParagraphs} scrollRef={scrollRef} readOnly={editingElsewhere} language={language} query={query} />
            )}
          </StudioCaptionEmojiLines>
        )}
        <Box h="32px" />
      </Box>
    </Box>
  );
}
