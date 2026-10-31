import type { EditorDocument } from "@narriflow/validators";

export function motionRenderAnalyticsMetadata(
  document: Pick<EditorDocument, "studioEdits" | "sceneBlocks" | "mediaMotions">,
  options: {
    applyScope: "clip" | "selected";
    fallbackCodes?: readonly string[];
    renderOutcome: "completed" | "failed";
  },
) {
  const families = new Set<string>();
  const durations: number[] = [];
  let targetCount = 0;
  if (document.studioEdits.transition.type !== "none") {
    families.add(`transition:${document.studioEdits.transition.type}`);
    durations.push(document.studioEdits.transition.durationSec);
    targetCount += 1;
  }
  for (const scene of document.sceneBlocks) {
    const active = [scene.motion.entrance, scene.motion.exit].filter(
      (family) => family !== "none",
    );
    if (active.length === 0) continue;
    active.forEach((family) => {
      families.add(`media:${family}`);
    });
    durations.push(scene.motion.durationSec);
    targetCount += 1;
  }
  for (const motion of document.mediaMotions) {
    if (!motion.enabled) continue;
    const active = [motion.entrance, motion.exit].filter(
      (family) => family !== "none",
    );
    if (active.length === 0) continue;
    active.forEach((family) => {
      families.add(`media:${family}`);
    });
    durations.push(motion.durationSec);
    targetCount += 1;
  }
  const longestDuration = Math.max(0, ...durations);
  return {
    motionFamily: [...families].sort(),
    durationBucket:
      longestDuration === 0
        ? "none"
        : longestDuration <= 0.35
          ? "short"
          : longestDuration <= 0.75
            ? "standard"
            : "long",
    targetCount,
    applyScope: options.applyScope,
    fallbackCode:
      options.fallbackCodes && options.fallbackCodes.length > 0
        ? [...new Set(options.fallbackCodes)].sort()
        : ["none"],
    renderOutcome: options.renderOutcome,
  };
}

export type MotionRenderAnalyticsMetadata = ReturnType<
  typeof motionRenderAnalyticsMetadata
>;

