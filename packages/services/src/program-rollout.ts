export type ProgramReleaseGroup =
  | "brand_profiles"
  | "visual_assets"
  | "brand_fonts"
  | "brand_kit_projection"
  | "campaign_operations"
  | "review_rooms"
  | "scene_cards"
  | "scene_images"
  | "scene_videos"
  | "scene_templates"
  | "generated_media"
  | "auto_censor_caption_masks"
  | "auto_censor_mute"
  | "auto_censor_beep";

const RELEASE_ENV: Record<ProgramReleaseGroup, string> = {
  brand_profiles: "NARRIFLOW_WRITES_BRAND_PROFILES",
  visual_assets: "NARRIFLOW_WRITES_VISUAL_ASSETS",
  brand_fonts: "NARRIFLOW_WRITES_BRAND_FONTS",
  brand_kit_projection: "NARRIFLOW_WRITES_BRAND_KIT_PROJECTION",
  campaign_operations: "NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS",
  review_rooms: "NARRIFLOW_WRITES_REVIEW_ROOMS",
  scene_cards: "NARRIFLOW_WRITES_SCENE_CARDS",
  scene_images: "NARRIFLOW_WRITES_SCENE_IMAGES",
  scene_videos: "NARRIFLOW_WRITES_SCENE_VIDEOS",
  scene_templates: "NARRIFLOW_WRITES_SCENE_TEMPLATES",
  generated_media: "NARRIFLOW_WRITES_GENERATED_MEDIA",
  auto_censor_caption_masks: "NARRIFLOW_WRITES_AUTO_CENSOR_CAPTION_MASKS",
  auto_censor_mute: "NARRIFLOW_WRITES_AUTO_CENSOR_MUTE",
  auto_censor_beep: "NARRIFLOW_WRITES_AUTO_CENSOR_BEEP",
};

export class ProgramWriteDisabledError extends Error {
  readonly code = "program_write_disabled";

  constructor(readonly group: ProgramReleaseGroup) {
    super("This feature is temporarily read-only");
    this.name = "ProgramWriteDisabledError";
  }
}

export function isProgramWriteEnabled(
  group: ProgramReleaseGroup,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[RELEASE_ENV[group]] === "1";
}

export function assertProgramWriteEnabled(
  group: ProgramReleaseGroup,
  env?: Record<string, string | undefined>,
): void {
  if (!isProgramWriteEnabled(group, env)) {
    throw new ProgramWriteDisabledError(group);
  }
}
