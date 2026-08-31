import {
  autoCensorRolloutFromEnv,
  autoCensorTreatmentWriteEnabled,
  hasFeature,
  motionRolloutFromEnv,
  sceneMotionWriteEnabled,
  studioTransitionWriteEnabled,
  type AutoCensorRollout,
  type MotionRollout,
} from "@narriflow/services";
import type {
  CensorSegment,
  EditorDocument,
  ApplyStudioEditsPatch,
  MediaMotion,
  SceneMotion,
} from "@narriflow/validators";

export type EditorDocumentFeatureMutationError = Readonly<{
  status: 403 | 503;
  error:
    | "auto_censor_feature_unavailable"
    | "auto_censor_rollout_unavailable"
    | "motion_feature_unavailable"
    | "motion_rollout_unavailable";
  message: string;
}>;

export type EditorDocumentFeatureRollout = Readonly<{
  autoCensor?: AutoCensorRollout;
  motion?: MotionRollout;
}>;

function equal(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function introducedCensorSegments(
  current: readonly CensorSegment[],
  next: readonly CensorSegment[],
): CensorSegment[] {
  const currentById = new Map(current.map((segment) => [segment.id, segment]));
  return next.filter((segment) => {
    const previous = currentById.get(segment.id);
    if (!previous || !equal(previous, segment)) {
      return !(
        previous?.enabled &&
          !segment.enabled &&
          equal({ ...previous, enabled: false }, segment)
      );
    }
    return false;
  });
}

function introducedMediaMotions(
  current: readonly MediaMotion[],
  next: readonly MediaMotion[],
): MediaMotion[] {
  const currentById = new Map(current.map((motion) => [motion.id, motion]));
  return next.filter((motion) => {
    const previous = currentById.get(motion.id);
    if (!previous || !equal(previous, motion)) {
      return !(
        previous?.enabled &&
          !motion.enabled &&
          equal({ ...previous, enabled: false }, motion)
      );
    }
    return false;
  });
}

function isStaticMotion(motion: SceneMotion): boolean {
  return motion.entrance === "none" && motion.exit === "none";
}

function introducedSceneMotions(
  current: EditorDocument,
  next: EditorDocument,
): SceneMotion[] {
  const currentById = new Map(
    current.sceneBlocks.map((scene) => [scene.id, scene.motion]),
  );
  return next.sceneBlocks.flatMap((scene) => {
    const previous = currentById.get(scene.id);
    if (previous && equal(previous, scene.motion)) return [];
    return isStaticMotion(scene.motion) ? [] : [scene.motion];
  });
}

function introducesMotionState(
  current: EditorDocument,
  next: EditorDocument,
): boolean {
  const changedTransition = !equal(
    current.studioEdits.transition,
    next.studioEdits.transition,
  );
  if (changedTransition && next.studioEdits.transition.type !== "none") {
    return true;
  }
  return (
    introducedMediaMotions(current.mediaMotions, next.mediaMotions).length > 0 ||
    introducedSceneMotions(current, next).length > 0
  );
}

/**
 * Server backstop for the generic Studio document replacement route. Preview
 * remains available on Free; persistence is paid. Removal and disabling stay
 * available after downgrade so premium edits never trap a document.
 */
export function editorDocumentFeatureMutationError(
  pricingTier: string,
  current: EditorDocument,
  next: EditorDocument,
  rollout: EditorDocumentFeatureRollout = {},
): EditorDocumentFeatureMutationError | null {
  const introducedCensor = introducedCensorSegments(
    current.censorSegments,
    next.censorSegments,
  );
  if (
    !hasFeature(pricingTier, "editor.censoring") &&
    introducedCensor.length > 0
  ) {
    return {
      status: 403,
      error: "auto_censor_feature_unavailable",
      message: "Saving censor treatments is not available on this plan",
    };
  }
  const autoCensor = rollout.autoCensor ?? autoCensorRolloutFromEnv();
  if (
    introducedCensor.some(
      (segment) =>
        !autoCensorTreatmentWriteEnabled(segment.treatment, autoCensor),
    )
  ) {
    return {
      status: 503,
      error: "auto_censor_rollout_unavailable",
      message: "This censor treatment is temporarily read-only",
    };
  }
  if (
    !hasFeature(pricingTier, "editor.motion") &&
    introducesMotionState(current, next)
  ) {
    return {
      status: 403,
      error: "motion_feature_unavailable",
      message: "Saving motion is not available on this plan",
    };
  }
  const motion = rollout.motion ?? motionRolloutFromEnv();
  if (
    !equal(current.studioEdits.transition, next.studioEdits.transition) &&
    !studioTransitionWriteEnabled(next.studioEdits.transition.type, motion)
  ) {
    return {
      status: 503,
      error: "motion_rollout_unavailable",
      message: "This motion family is temporarily read-only",
    };
  }
  const introducedMedia = introducedMediaMotions(
    current.mediaMotions,
    next.mediaMotions,
  );
  const introducedScene = introducedSceneMotions(current, next);
  if (
    [...introducedMedia, ...introducedScene].some(
      (candidate) => !sceneMotionWriteEnabled(candidate, motion),
    )
  ) {
    return {
      status: 503,
      error: "motion_rollout_unavailable",
      message: "This motion family is temporarily read-only",
    };
  }
  return null;
}

export function studioMotionPatchFeatureError(
  pricingTier: string,
  patches: readonly ApplyStudioEditsPatch[],
  rollout: MotionRollout = motionRolloutFromEnv(),
): EditorDocumentFeatureMutationError | null {
  const transitions = patches.flatMap((patch) =>
    patch.transition === undefined || patch.transition.type === "none"
      ? []
      : [patch.transition.type],
  );
  if (!hasFeature(pricingTier, "editor.motion") && transitions.length > 0) {
    return {
      status: 403,
      error: "motion_feature_unavailable",
      message: "Saving motion is not available on this plan",
    };
  }
  if (
    transitions.some(
      (transition) => !studioTransitionWriteEnabled(transition, rollout),
    )
  ) {
    return {
      status: 503,
      error: "motion_rollout_unavailable",
      message: "This motion family is temporarily read-only",
    };
  }
  return null;
}
