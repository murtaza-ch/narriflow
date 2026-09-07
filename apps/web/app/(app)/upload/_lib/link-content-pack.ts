import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  clipLengthPresetRanges,
  contentPackSchema,
  PLATFORM_PLAYBOOK_VERSION,
  type CaptionPresetId,
  type ClipLengthPreset,
  type ClipPlatformTarget,
  type ContentPack,
  type GenerationMode,
} from "@narriflow/validators";

/**
 * Step 2 (Configure) settings for the link-first flow — a distinct shape
 * from `UploadSettingsFormInput` in `content-pack-form.ts` (the FormData
 * helper shared by the untouched file/RSS paths) since Configure promotes
 * clip length, caption preset, and aspect ratio to their own bands and
 * drops fields (title, brand template) that belong to Step 1 instead.
 */
export interface LinkConfigureState {
  mode: GenerationMode;
  clipLengthPreset: ClipLengthPreset;
  captionPreset: CaptionPresetId;
  defaultAspectRatio: ContentPack["defaultAspectRatio"];
  autoHook: boolean;
  autoRenderClips: boolean;
  specificMoments: string;
  platformTargets: ClipPlatformTarget[];
  clipCountTarget: number;
  /** Comma-separated, matching the existing tone input's plain-text shape. */
  toneConstraints: string;
  processingStartSec: number | null;
  processingEndSec: number | null;
}

/** Builds the final ContentPack for `finalizeLinkConfigureAction`. Reads
 *  duration ranges from the shared `clipLengthPresetRanges` table — never
 *  invents its own numbers for a preset. */
export function buildLinkContentPack(state: LinkConfigureState): ContentPack {
  const range = clipLengthPresetRanges[state.clipLengthPreset];
  const toneConstraints = state.toneConstraints
    .split(",")
    .map((tone) => tone.trim())
    .filter(Boolean);

  return contentPackSchema.parse({
    outputTypes: ["short_clip"],
    clipGenerationMode: "best",
    clipCountTarget: state.clipCountTarget,
    clipDurationSecTarget: range.clipDurationSecTarget,
    minDurationSec: range.minDurationSec,
    preferredMinDurationSec: range.preferredMinDurationSec,
    preferredMaxDurationSec: range.preferredMaxDurationSec,
    maxDurationSec: range.maxDurationSec,
    platformTargets:
      state.platformTargets.length > 0
        ? state.platformTargets
        : ["tiktok", "youtube_shorts", "instagram_reels"],
    autoRenderClips: state.autoRenderClips,
    toneConstraints:
      toneConstraints.length > 0 ? toneConstraints : ["concise", "conversational"],
    captionPreset: state.captionPreset,
    platformPlaybookVersion: PLATFORM_PLAYBOOK_VERSION,
    mode: state.mode,
    autoHook: state.autoHook,
    specificMoments: state.specificMoments.slice(0, 500),
    processingStartSec: state.processingStartSec,
    processingEndSec: state.processingEndSec,
    clipLengthPreset: state.clipLengthPreset,
    defaultAspectRatio: state.defaultAspectRatio,
  });
}

export const DEFAULT_LINK_CONFIGURE_STATE: Omit<
  LinkConfigureState,
  "mode" | "processingStartSec" | "processingEndSec"
> = {
  clipLengthPreset: "auto",
  captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID,
  defaultAspectRatio: "9:16",
  autoHook: true,
  autoRenderClips: false,
  specificMoments: "",
  platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
  clipCountTarget: 10,
  toneConstraints: "concise, conversational",
};
