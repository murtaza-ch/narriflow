// The cut plan is shared policy: the render, the Studio preview timeline, and
// timeline exports for editors all keep the same segments, so it lives with
// the edit-range math in packages/validators/src/edit-ranges.ts. Worker
// modules import it from here.
export {
  buildClipCutPlan,
  MIN_KEPT_SEGMENT_SEC,
  type ClipCutPlan,
} from "@narriflow/validators";
