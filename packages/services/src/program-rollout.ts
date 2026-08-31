import {
  mediaMotionReleased,
  transitionMotionReleased,
} from "@narriflow/validators";
import type {
  ApplyMotionSelectedInput,
  AutoCensorTreatment,
  MotionRolloutState,
  SceneMotion,
  StudioTransition,
} from "@narriflow/validators";

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
  | "assisted_copy"
  | "thumbnail_extraction"
  | "bulk_scheduling";

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
  assisted_copy: "NARRIFLOW_WRITES_ASSISTED_COPY",
  thumbnail_extraction: "NARRIFLOW_WRITES_THUMBNAIL_EXTRACTION",
  bulk_scheduling: "NARRIFLOW_WRITES_BULK_SCHEDULING",
};

export type AutoCensorRollout = Readonly<{
  scan: boolean;
  captionMask: boolean;
  mute: boolean;
  beep: boolean;
  freePreviewLimit: 10;
}>;

/**
 * Auto Censor is released as one ordered chain. A later flag cannot open a
 * treatment while any earlier stage is off, which makes partial or mistyped
 * deployment configuration fail closed.
 */
export function autoCensorRolloutFromEnv(
  env: Record<string, string | undefined> = process.env,
): AutoCensorRollout {
  const scan = env.NARRIFLOW_WRITES_CENSOR_SCAN === "1";
  const captionMask =
    scan && env.NARRIFLOW_WRITES_CENSOR_CAPTION_MASK === "1";
  const mute = captionMask && env.NARRIFLOW_WRITES_CENSOR_MUTE === "1";
  const beep = mute && env.NARRIFLOW_WRITES_CENSOR_BEEP === "1";
  return { scan, captionMask, mute, beep, freePreviewLimit: 10 };
}

export function autoCensorTreatmentWriteEnabled(
  treatment: AutoCensorTreatment,
  rollout: AutoCensorRollout = autoCensorRolloutFromEnv(),
): boolean {
  if (treatment === "caption_mask") return rollout.captionMask;
  if (treatment === "mute") return rollout.mute;
  if (treatment === "beep") return rollout.beep;
  return false;
}

export type MotionRollout = MotionRolloutState;

/** Zoom follows the directional transition families and precedes media
 * animation. It has distinct geometry and therefore gets its own switch and
 * rollback drill instead of borrowing Slide's evidence. */
export function motionRolloutFromEnv(
  env: Record<string, string | undefined> = process.env,
): MotionRollout {
  const legacyTransitions =
    env.NARRIFLOW_MOTION_SHADOW_LEGACY_TRANSITIONS === "1";
  const crossDissolve =
    legacyTransitions && env.NARRIFLOW_WRITES_MOTION_CROSS_DISSOLVE === "1";
  const directionalWipe =
    crossDissolve && env.NARRIFLOW_WRITES_MOTION_DIRECTIONAL_WIPE === "1";
  const directionalSlide =
    directionalWipe &&
    env.NARRIFLOW_WRITES_MOTION_DIRECTIONAL_SLIDE === "1";
  const zoom = directionalSlide && env.NARRIFLOW_WRITES_MOTION_ZOOM === "1";
  const mediaFadeScale =
    zoom && env.NARRIFLOW_WRITES_MOTION_MEDIA_FADE_SCALE === "1";
  const panKenBurns =
    mediaFadeScale &&
    env.NARRIFLOW_WRITES_MOTION_PAN_KEN_BURNS === "1";
  const campaignApply =
    panKenBurns && env.NARRIFLOW_WRITES_MOTION_CAMPAIGN_APPLY === "1";
  return {
    legacyTransitions,
    crossDissolve,
    directionalWipe,
    directionalSlide,
    zoom,
    mediaFadeScale,
    panKenBurns,
    campaignApply,
  };
}

export function studioTransitionWriteEnabled(
  transition: StudioTransition["type"],
  rollout: MotionRollout = motionRolloutFromEnv(),
): boolean {
  return transitionMotionReleased(transition, rollout);
}

export function sceneMotionWriteEnabled(
  motion: SceneMotion,
  rollout: MotionRollout = motionRolloutFromEnv(),
): boolean {
  return (
    mediaMotionReleased(motion.entrance, rollout) &&
    mediaMotionReleased(motion.exit, rollout)
  );
}

export function campaignMotionWriteEnabled(
  change: ApplyMotionSelectedInput["change"],
  rollout: MotionRollout = motionRolloutFromEnv(),
): boolean {
  if (!rollout.campaignApply) return false;
  return change.scope === "clip_transition"
    ? studioTransitionWriteEnabled(change.transition.type, rollout)
    : sceneMotionWriteEnabled(change.motion, rollout);
}

export type CampaignActionRollout = Readonly<{
  render: boolean;
  exports: boolean;
  creative: boolean;
  delivery: boolean;
  review: boolean;
  scheduling: boolean;
}>;

export type PublishingPreparationRollout = Readonly<{
  assistedCopy: boolean;
  thumbnailExtraction: boolean;
  bulkScheduling: boolean;
}>;

export function publishingPreparationRolloutFromEnv(
  env: Record<string, string | undefined> = process.env,
): PublishingPreparationRollout {
  const assistedCopy = env.NARRIFLOW_WRITES_ASSISTED_COPY === "1";
  const thumbnailExtraction =
    assistedCopy && env.NARRIFLOW_WRITES_THUMBNAIL_EXTRACTION === "1";
  const bulkScheduling =
    thumbnailExtraction && env.NARRIFLOW_WRITES_BULK_SCHEDULING === "1";
  return { assistedCopy, thumbnailExtraction, bulkScheduling };
}

/**
 * Campaign Operations first observes the existing Render selected path, then
 * adds immutable delivery, creative document changes, and finally the two
 * downstream handoffs. Review and scheduling also require their owning
 * service controls, so the Clips view cannot advertise a disabled target.
 */
export function campaignActionRolloutFromEnv(
  env: Record<string, string | undefined> = process.env,
): CampaignActionRollout {
  const parent = env.NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS === "1";
  const render = parent && env.NARRIFLOW_WRITES_CAMPAIGN_RENDER === "1";
  const exports = render && env.NARRIFLOW_WRITES_CAMPAIGN_EXPORTS === "1";
  const creative = exports && env.NARRIFLOW_WRITES_CAMPAIGN_CREATIVE === "1";
  const delivery =
    creative && env.NARRIFLOW_WRITES_CAMPAIGN_DELIVERY === "1";
  const publishing = publishingPreparationRolloutFromEnv(env);
  return {
    render,
    exports,
    creative,
    delivery,
    review: delivery && env.NARRIFLOW_WRITES_REVIEW_ROOMS === "1",
    scheduling: delivery && publishing.bulkScheduling,
  };
}

export class ProgramWriteDisabledError extends Error {
  readonly code = "program_write_disabled";

  constructor(readonly group: ProgramReleaseGroup) {
    super("This feature is temporarily read-only");
    this.name = "ProgramWriteDisabledError";
  }
}

export function assertCampaignMotionWriteEnabled(
  change: ApplyMotionSelectedInput["change"],
  rollout?: MotionRollout,
): void {
  if (!campaignMotionWriteEnabled(change, rollout)) {
    throw new ProgramWriteDisabledError("campaign_operations");
  }
}

export type PublishingPreparationStage =
  | "assisted_copy"
  | "thumbnail_extraction"
  | "bulk_scheduling";

export function assertPublishingPreparationWriteEnabled(
  stage: PublishingPreparationStage,
  rollout: PublishingPreparationRollout =
    publishingPreparationRolloutFromEnv(),
): void {
  const enabled =
    stage === "assisted_copy"
      ? rollout.assistedCopy
      : stage === "thumbnail_extraction"
        ? rollout.thumbnailExtraction
        : rollout.bulkScheduling;
  if (!enabled) throw new ProgramWriteDisabledError(stage);
}

export type CampaignRolloutAction =
  | "render_selected"
  | "export_bundle"
  | "apply_brand_profile"
  | "apply_style"
  | "apply_scene_template"
  | "apply_motion"
  | "create_review"
  | "schedule_selected";

export function campaignActionWriteEnabled(
  action: CampaignRolloutAction,
  rollout: CampaignActionRollout = campaignActionRolloutFromEnv(),
): boolean {
  if (action === "render_selected") return rollout.render;
  if (action === "export_bundle") return rollout.exports;
  if (action === "create_review") return rollout.review;
  if (action === "schedule_selected") return rollout.scheduling;
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
