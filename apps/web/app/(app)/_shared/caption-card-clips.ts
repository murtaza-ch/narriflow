import type { CaptionFontName, CaptionPreset } from "@narriflow/validators";
import manifest from "./caption-card-clips.json";

export { PRESET_CARD_FRAME } from "./caption-card-frame";

export interface CaptionCardClipEntry {
  /** `captionCardSourceHash` of what the clip was rendered from; a mismatch means the clip is stale. */
  readonly hash: string;
  /** The faces a Scene Style's sample draws with, loaded when a card is pointed at so its first build measures once. */
  readonly faces: readonly CaptionFontName[];
}

export const CAPTION_CARD_CLIPS: Readonly<Record<string, CaptionCardClipEntry>> = manifest.cards as Record<string, CaptionCardClipEntry>;

/**
 * Whether a preset's card plays a pre-rendered clip. Dynamic and Scene Styles do: their live samples run the block and
 * scene painters every frame, and a gallery of them froze the Studio. Classic styles stay live (plain DOM, cheap).
 */
export function presetHasCardClip(preset: CaptionPreset): boolean {
  return preset.dynamic !== undefined || preset.scene !== undefined;
}
