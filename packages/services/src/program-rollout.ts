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

export type CampaignActionRollout = Readonly<{
  render: boolean;
  exports: boolean;
  creative: boolean;
  review: false;
  scheduling: false;
}>;

export type CampaignRolloutAction =
  | "render_selected"
  | "export_bundle"
  | "apply_brand_profile"
  | "apply_style"
  | "apply_scene_template"
  | "apply_motion";

export type ReviewRoomRollout = Readonly<{
  internalCreation: boolean;
  guestRead: boolean;
  feedback: boolean;
  notifications: boolean;
}>;

export function reviewRoomRolloutFromEnv(
  env: Record<string, string | undefined> = process.env,
): ReviewRoomRollout {
  const internalCreation = env.NARRIFLOW_WRITES_REVIEW_ROOMS === "1";
  const guestRead = env.NARRIFLOW_READS_REVIEW_GUEST === "1";
  const feedback = guestRead && env.NARRIFLOW_WRITES_REVIEW_FEEDBACK === "1";
  const notifications = feedback && env.NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS === "1";
  return { internalCreation, guestRead, feedback, notifications };
}

export function campaignActionRolloutFromEnv(
  env: Record<string, string | undefined> = process.env,
): CampaignActionRollout {
  const parent = env.NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS === "1";
  const render = parent && env.NARRIFLOW_WRITES_CAMPAIGN_RENDER === "1";
  const exports = render && env.NARRIFLOW_WRITES_CAMPAIGN_EXPORTS === "1";
  const creative = exports && env.NARRIFLOW_WRITES_CAMPAIGN_CREATIVE === "1";
  return { render, exports, creative, review: false, scheduling: false };
}

export function campaignActionWriteEnabled(
  action: CampaignRolloutAction,
  rollout: CampaignActionRollout = campaignActionRolloutFromEnv(),
): boolean {
  if (action === "render_selected") return rollout.render;
  if (action === "export_bundle") return rollout.exports;
  return rollout.creative;
}

export function assertCampaignActionWriteEnabled(
  action: CampaignRolloutAction,
  rollout?: CampaignActionRollout,
): void {
  if (!campaignActionWriteEnabled(action, rollout)) {
    throw new ProgramWriteDisabledError("campaign_operations");
  }
}

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
