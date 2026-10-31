import { Prisma } from "@prisma/client";
import { BRAND_DEFAULT_CAPTION_PRESET_ID, DEFAULT_CAPTION_PRESET, EDITOR_DOCUMENT_VERSION, brandProfileSnapshotSchema, captionPresetSchema, captionedVideoFramingEdits,
  clipSourceEdgeSec, getCaptionPresetById, isBrandDefaultCaptionPresetId, studioEditsSchema,
  type BrollCue, type CaptionPreset, type ClipCategory, type ClipPlatformTarget, type ContentPack, type StudioEdits, type TranscriptUtterance } from "@narriflow/validators";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";

export interface DetectedClipSeed { captionPreset: CaptionPreset; studioEdits: StudioEdits; sourceDurationSec: number | null; wholeSource: boolean }
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

export function seedBrandMusic(
  studioEdits: StudioEdits,
  brandProfileSnapshot: unknown,
): StudioEdits {
  if (studioEdits.music.assetId || studioEdits.music.url) return studioEdits;
  const snapshot = brandProfileSnapshotSchema.safeParse(brandProfileSnapshot);
  const track = snapshot.success ? snapshot.data.audio.music[0] : undefined;
  if (!track) return studioEdits;
  return {
    ...studioEdits,
    music: { ...studioEdits.music, assetId: track.assetId, title: track.title, url: null },
  };
}

/** The caption style a generation run gives its clips: the run's Content Pack
 * choice, or the Brand Profile style snapshotted on the Project. */
export function runDefaultCaptionPreset(brandSnapshot: unknown, captionPresetId: string | null | undefined): CaptionPreset {
  let template: CaptionPreset | null = null;
  if (brandSnapshot && typeof brandSnapshot === "object" && !Array.isArray(brandSnapshot)) {
    const snap = brandSnapshot as Record<string, unknown>;
    if (snap.captionPreset && typeof snap.captionPreset === "object") {
      template = captionPresetSchema.parse(snap.captionPreset);
    }
  }
  return resolveClipCaptionPresetForContentPack(captionPresetId, template) ?? DEFAULT_CAPTION_PRESET;
}

export function prepareDetectedClipSeed(project: { brandSnapshot: unknown; brandProfileSnapshot: unknown; sourceDurationSeconds: number | null; sourceProbe?: unknown } | null,
  contentPack?: ContentPack | null): DetectedClipSeed {
    const resolvedCaptionPreset = runDefaultCaptionPreset(
      project?.brandSnapshot,
      contentPack?.captionPreset,
    );
    // A caption-only generation's clip is its whole source (see
    // clipDurationBounds). A captioned video also states how to frame it.
    const wholeSource = contentPack?.mode === "caption_only";
    const studioEdits = seedBrandMusic(
      studioEditsSchema.parse(
        contentPack?.captionedVideo ? captionedVideoFramingEdits(contentPack.captionedVideo.framing) : undefined,
      ),
      project?.brandProfileSnapshot,
    );

    return { captionPreset: resolvedCaptionPreset, studioEdits, sourceDurationSec: project ? clipSourceEdgeSec(project) : null, wholeSource };
}

/** One canonical Editor Document writer is shared by worker and durable selection. */
export function buildDetectedClipRows(input: { projectId: string; workflowRunId: string; clips: DetectedClip[]; llmMeta: LlmMeta; seed: DetectedClipSeed }) {
  const { projectId, workflowRunId, clips, llmMeta, seed } = input;
    return clips.map((clip, i) => {
		const editorDocument = encodeClipEditorDocumentForStorage(
			{
				version: EDITOR_DOCUMENT_VERSION,
				clipStartSec: clip.startSec,
				clipEndSec: clip.endSec,
          captionPreset: seed.captionPreset,
          transcriptSlice: clip.transcriptSlice,
          studioEdits: seed.studioEdits,
				brollUrl: null,
				deletedRanges: [],
				sceneBlocks: [],
				censorSegments: [],
				mediaMotions: [],
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
