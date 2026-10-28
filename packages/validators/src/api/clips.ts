// Request schemas of the clips routes (clips, campaign operations, thumbnail frames),
// gathered so the API adapter and the client import one definition per input.
export {
  applyCaptionPresetToAllSchema,
  clipDownloadQuerySchema,
  createClipFromSelectionSchema,
  regenerateClipsRequestSchema,
  triggerClipRenderSchema,
  type ClipDownloadQuery,
  type CreateClipFromSelection,
  type RegenerateClipsRequest,
} from "../clip";
export {
  applyMotionSelectedSchema,
  applyProjectBrandProfileSelectedSchema,
  applyStyleSelectedSchema,
  previewCampaignEditorActionSchema,
} from "../campaign-operation";
export { requestThumbnailFrameSchema } from "../assisted-publishing";
export { applyStudioEditsToAllSchema } from "../studio-edits";
