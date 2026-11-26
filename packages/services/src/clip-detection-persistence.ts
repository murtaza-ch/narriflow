import { Prisma } from "@prisma/client";
import { BRAND_DEFAULT_CAPTION_PRESET_ID, DEFAULT_CAPTION_EMOJI_DENSITY, DEFAULT_CAPTION_PRESET, EDITOR_DOCUMENT_VERSION, brandProfileSnapshotSchema, brandTemplateSnapshotSchema,
  brandTitleOrDefault, captionPresetSchema, titleTextLayer,
  captionWordKey, captionedVideoFramingEdits, clipEmphasisWords, clipSourceEdgeSec, decodeQuietRanges, detectClipCleanupRanges, encodedQuietRangesSchema, getCaptionPresetById,
  isBrandDefaultCaptionPresetId, replaceCaptionEmojis, selectCaptionEmojiPicks, studioEditsSchema, studioMusicBlockSchema,
  type BrollCue, type CaptionEmojiPick, type CaptionPreset, type ClipCategory, type ClipPlatformTarget, type ContentPack, type EncodedQuietRanges,
  type BrandTitle, type FillerTaggingOutcome, type SourceRange, type StudioEdits, type TranscriptUtterance } from "@narriflow/validators";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";
import { clipEmojiWords } from "./clip-emoji-suggestion";
import { clipEditedDurationSec, clipTitleWords } from "./clip-title-text";

/** Cleanup a generation asked for, with what it needs per clip. */
export interface DetectedClipCleanup { removeSilences: boolean; removeFillerWords: boolean; quietRanges: EncodedQuietRanges | null; languageCode: string | null; aiFillers: FillerTaggingOutcome | null }
export interface DetectedClipSeed { captionPreset: CaptionPreset; studioEdits: StudioEdits; sourceDurationSec: number | null; wholeSource: boolean; cleanup: DetectedClipCleanup;
  /** AI emoji picks over the whole source by Word Key; null when the generation adds none. */
  emojiPicks: CaptionEmojiPick[] | null;
  /** The project's brand title settings (its template snapshot's); null is the built-in default. */
  title: BrandTitle | null }
export interface DetectedClip {
  startSec: number;
  endSec: number;
  title: string | null;
  hookText: string;
  payoffText: string | null;
  reasoning: string;
  category: ClipCategory;
  platformFit: ClipPlatformTarget[];
  hookStrengthScore: number;
  emotionalIntensityScore: number;
  storyCompletenessScore: number;
  pacingScore: number;
  durationOptimalityScore: number;
  viralityScore: number;
  tiktokScore: number;
  youtubeScore: number;
  instagramScore: number;
  transcriptSlice: TranscriptUtterance[];
  /** LLM-suggested B-roll cutaway moments, `atSec` relative to the clip's own
   *  start. Optional: the caption-only detection path emits no cues, and older
   *  rows predate the column. When absent the render falls back to the
   *  keyword-derived Pexels query. */
  brollCues?: BrollCue[];
  /** Clip Emphasis Words as the selection model wrote them. Only those found
   *  in `transcriptSlice` are stored; absent on the caption-only path. */
  emphasisWords?: string[];
}

export interface LlmMeta {
  provider: string;
  model: string;
  totalTokensUsed: number | null;
}

export function resolveClipCaptionPresetForContentPack(
  captionPresetId: string | null | undefined,
  templateCaptionPreset: CaptionPreset | null,
): CaptionPreset | null {
  const id =
    captionPresetId && captionPresetId.trim()
      ? captionPresetId
      : BRAND_DEFAULT_CAPTION_PRESET_ID;

  if (isBrandDefaultCaptionPresetId(id)) {
    return templateCaptionPreset;
  }

  return getCaptionPresetById(id)?.preset ?? templateCaptionPreset;
}

/** `blockId` defaults to a fresh id; a seed that is hashed passes a fixed one. */
export function seedBrandMusic(
  studioEdits: StudioEdits,
  brandProfileSnapshot: unknown,
  blockId: string = crypto.randomUUID(),
): StudioEdits {
  if (studioEdits.music.blocks.length > 0) return studioEdits;
  const snapshot = brandProfileSnapshotSchema.safeParse(brandProfileSnapshot);
  const track = snapshot.success ? snapshot.data.audio.music[0] : undefined;
  if (!track) return studioEdits;
  return {
    ...studioEdits,
    // One full-length bed from the clip start, Studio defaults for the rest.
    music: {
      ...studioEdits.music,
      blocks: [
        studioMusicBlockSchema.parse({
          id: blockId,
          assetId: track.assetId,
          title: track.title,
          startSec: 0,
          endSec: null,
          sourceStartSec: 0,
        }),
      ],
    },
  };
}

/** The caption style a generation run gives its clips: the run's Content Pack
 * choice, or the Brand Profile style snapshotted on the Project. The import's
 * Add emojis choice alone decides emojis, whatever the brand style says. */
export function runDefaultCaptionPreset(brandSnapshot: unknown, contentPack: { captionPreset?: string | null; addEmojis?: boolean } | null | undefined): CaptionPreset {
  return { ...runCaptionStyle(brandSnapshot, contentPack?.captionPreset), emojis: contentPack?.addEmojis ?? false };
}

function runCaptionStyle(brandSnapshot: unknown, captionPresetId: string | null | undefined): CaptionPreset {
  let template: CaptionPreset | null = null;
  if (brandSnapshot && typeof brandSnapshot === "object" && !Array.isArray(brandSnapshot)) {
    const snap = brandSnapshot as Record<string, unknown>;
    // An unreadable stored preset counts as none: the run falls back as without a template preset.
    const parsed = snap.captionPreset && typeof snap.captionPreset === "object" ? captionPresetSchema.safeParse(snap.captionPreset) : null;
    if (parsed?.success) template = parsed.data;
  }
  return resolveClipCaptionPresetForContentPack(captionPresetId, template) ?? DEFAULT_CAPTION_PRESET;
}

export function prepareDetectedClipSeed(project: { brandSnapshot: unknown; brandProfileSnapshot: unknown; sourceDurationSeconds: number | null; sourceProbe?: unknown } | null,
  contentPack: ContentPack | null, source: { quietRanges: unknown; languageCode: string | null; aiFillers?: FillerTaggingOutcome | null; emojiPicks?: CaptionEmojiPick[] | null }): DetectedClipSeed {
    const resolvedCaptionPreset = runDefaultCaptionPreset(project?.brandSnapshot, contentPack);
    // A caption-only generation's clip is its whole source (see
    // clipDurationBounds). Preserve its whole frame unless it explicitly asks
    // for Center; Auto framing belongs to AI clipping by default.
    const wholeSource = contentPack?.mode === "caption_only";
    const studioEdits = seedBrandMusic(
      studioEditsSchema.parse(
        wholeSource ? captionedVideoFramingEdits(contentPack?.captionedVideo?.framing ?? "fit") : undefined,
      ),
      project?.brandProfileSnapshot,
      // The seed is hashed and compared when selection commits, so nothing random goes in it.
      "brand-music",
    );

    // Stored quiet ranges that fail the schema count as not measured.
    const quietRanges = encodedQuietRangesSchema.safeParse(source.quietRanges);
    const cleanup = { removeSilences: contentPack?.removeSilences ?? false, removeFillerWords: contentPack?.removeFillerWords ?? false,
      quietRanges: quietRanges.success ? quietRanges.data : null, languageCode: source.languageCode, aiFillers: source.aiFillers ?? null };
    return { captionPreset: resolvedCaptionPreset, studioEdits, sourceDurationSec: project ? clipSourceEdgeSec(project) : null, wholeSource, cleanup, emojiPicks: source.emojiPicks ?? null,
      title: projectBrandTitle(project?.brandSnapshot) };
}

/** The title settings of the project's template snapshot; null (the built-in default) when it has none or does not parse. */
function projectBrandTitle(brandSnapshot: unknown): BrandTitle | null {
  const snapshot = brandTemplateSnapshotSchema.safeParse(brandSnapshot);
  return snapshot.success ? snapshot.data.title : null;
}

/** Picks keyed as the clip's words are: slicing clamps a source word that straddles the clip start to
 * that start (`normalizeTranscriptSliceForClip`), which changes its Word Key. */
function clipEmojiPicks(picks: readonly CaptionEmojiPick[], utterances: readonly TranscriptUtterance[], clipStartSec: number): readonly CaptionEmojiPick[] {
  const clamped = new Set(utterances.flatMap((utterance) => utterance.words
    .filter((word) => word.startSec < clipStartSec && word.endSec > clipStartSec).map((word) => captionWordKey(word.startSec))));
  if (clamped.size === 0) return picks;
  const key = captionWordKey(clipStartSec);
  return picks.map((pick) => (clamped.has(pick.key) ? { ...pick, key } : pick));
}

/** The seed's Studio Edits for one clip: the source picks its kept words hold, at the default density, and its title. */
function clipStudioEdits(seed: DetectedClipSeed, clip: DetectedClip, deletedRanges: SourceRange[], utterances: readonly TranscriptUtterance[]): StudioEdits {
  const withEmojis = clipSeedEmojis(seed, clip, deletedRanges, utterances);
  // Caption-only generation (the whole source) gets no auto title.
  const settings = brandTitleOrDefault(seed.title);
  const title = settings.enabled && !seed.wholeSource
    ? titleTextLayer({ text: clipTitleWords(clip.title, clip.hookText), settings, editedDurationSec: clipEditedDurationSec(clip, deletedRanges) })
    : null;
  return title ? { ...withEmojis, textLayers: [...withEmojis.textLayers, title] } : withEmojis;
}

function clipSeedEmojis(seed: DetectedClipSeed, clip: DetectedClip, deletedRanges: SourceRange[], utterances: readonly TranscriptUtterance[]): StudioEdits {
  if (!seed.emojiPicks?.length || !seed.captionPreset.emojis) return seed.studioEdits;
  const { words } = clipEmojiWords({ transcriptSlice: clip.transcriptSlice, clipStartSec: clip.startSec, clipEndSec: clip.endSec, deletedRanges });
  const picks = clipEmojiPicks(seed.emojiPicks, utterances, clip.startSec);
  // selectCaptionEmojiPicks keeps at most CAPTION_EMOJI_LIMIT, so the replace never refuses.
  return replaceCaptionEmojis(seed.studioEdits, selectCaptionEmojiPicks(picks, words, DEFAULT_CAPTION_EMOJI_DENSITY)) ?? seed.studioEdits;
}

/** One canonical Editor Document writer is shared by worker and durable selection. `utterances` is the
 * source transcript the clips were sliced from (the selection capsule's). */
export function buildDetectedClipRows(input: { projectId: string; workflowRunId: string; clips: DetectedClip[]; llmMeta: LlmMeta; seed: DetectedClipSeed;
  utterances: readonly TranscriptUtterance[] }) {
  const { projectId, workflowRunId, clips, llmMeta, seed, utterances } = input;
  const { cleanup } = seed;
  const quietRanges = cleanup.quietRanges ? decodeQuietRanges(cleanup.quietRanges) : null;
  const aiFillerKeys = cleanup.aiFillers ? new Set(cleanup.aiFillers.keys) : null;
    return clips.map((clip, i) => {
      const emphasisWords = clipEmphasisWords(clip.emphasisWords ?? [], clip.transcriptSlice);
      const deletedRanges = detectClipCleanupRanges(clip.transcriptSlice, { startSec: clip.startSec, endSec: clip.endSec },
        { removeSilences: cleanup.removeSilences, removeFillerWords: cleanup.removeFillerWords, quietRanges, languageCode: cleanup.languageCode, aiFillerKeys });
		const editorDocument = encodeClipEditorDocumentForStorage(
			{
				version: EDITOR_DOCUMENT_VERSION,
				clipStartSec: clip.startSec,
				clipEndSec: clip.endSec,
          captionPreset: seed.captionPreset,
          transcriptSlice: clip.transcriptSlice,
          studioEdits: clipStudioEdits(seed, clip, deletedRanges, utterances),
				brollUrl: null,
				deletedRanges,
				sceneBlocks: [],
				censorSegments: [],
				mediaMotions: [],
				...(emphasisWords.length > 0 ? { emphasisWords } : {}),
			},
        { durationSec: seed.sourceDurationSec, wholeSource: seed.wholeSource },
      );
      return {
            projectId,
            workflowRunId,
            index: i,
            ...editorDocument,
            title: clip.title,
            hookText: clip.hookText,
            payoffText: clip.payoffText,
            reasoning: clip.reasoning,
            category: clip.category,
            platformFit: clip.platformFit,
            brollCues:
              clip.brollCues && clip.brollCues.length > 0
                ? (clip.brollCues as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            viralityScore: clip.viralityScore,
            hookStrengthScore: clip.hookStrengthScore,
            emotionalIntensityScore: clip.emotionalIntensityScore,
            storyCompletenessScore: clip.storyCompletenessScore,
            pacingScore: clip.pacingScore,
            durationOptimalityScore: clip.durationOptimalityScore,
            tiktokScore: clip.tiktokScore,
            youtubeScore: clip.youtubeScore,
            instagramScore: clip.instagramScore,
            llmProvider: llmMeta.provider,
            llmModel: llmMeta.model,
            llmTokensUsed: llmMeta.totalTokensUsed,
          };
    }) satisfies Prisma.ClipCreateManyInput[];
}
