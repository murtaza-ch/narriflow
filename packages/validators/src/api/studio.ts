import { z } from "zod";
import { autoCensorAnalyticsInputSchema } from "../auto-censor";
import { projectCensorTermsSchema } from "../censor-words";
import {
  updateClipBoundariesSchema,
  updateClipBrollSchema,
  updateClipCaptionPresetSchema,
  updateClipTitleSchema,
  updateClipTranscriptSliceSchema,
} from "../clip";
import {
  resetEditorDocumentSchema,
  saveEditorDocumentSchema,
} from "../editor-document";
import { updateClipStudioEditsSchema } from "../studio-edits";

export { resetEditorDocumentSchema, saveEditorDocumentSchema };

/**
 * Every field of the studio-edits schema has a default, so a body with no
 * `studioEdits` key would otherwise parse as "reset every edit to defaults".
 * The key must be present for the body to mean this update.
 */
const requiresStudioEdits = z.custom<z.input<typeof updateClipStudioEditsSchema>>(
  (value) => typeof value === "object" && value !== null && "studioEdits" in value,
);

/**
 * `PATCH /api/projects/:id/clips/:clipId` body. Exactly one supported update;
 * the first schema that matches the body wins, in this order, so a body that
 * mixes keys keeps meaning what it always meant. The output names the update,
 * so the handler dispatches on `kind` rather than re-sniffing keys.
 */
export const patchClipRequestSchema = z.union([
  updateClipTitleSchema.transform((body) => ({ kind: "rename" as const, title: body.title })),
  updateClipBoundariesSchema.transform((body) => ({
    kind: "set_boundaries" as const,
    startSec: body.startSec,
    endSec: body.endSec,
  })),
  updateClipCaptionPresetSchema.transform((body) => ({
    kind: "set_caption_preset" as const,
    captionPreset: body.captionPreset,
  })),
  updateClipTranscriptSliceSchema.transform((body) => ({
    kind: "set_transcript" as const,
    transcriptSlice: body.transcriptSlice,
  })),
  updateClipBrollSchema.transform((body) => ({
    kind: "set_broll_url" as const,
    brollUrl: body.brollUrl,
  })),
  requiresStudioEdits.pipe(updateClipStudioEditsSchema).transform((body) => ({
    kind: "set_studio_edits" as const,
    studioEdits: body.studioEdits,
  })),
]);

export type PatchClipRequest = z.output<typeof patchClipRequestSchema>;

/** `PUT /api/projects/:id/censor-terms` body: the whole Project list, replaced. */
export const replaceProjectCensorTermsRequestSchema = z.object({
  terms: projectCensorTermsSchema,
});

/** `POST /api/projects/:id/clips/:clipId/censor-events` body (best-effort analytics). */
export const recordCensorEventRequestSchema = autoCensorAnalyticsInputSchema;
