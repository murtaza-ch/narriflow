import { z } from "zod";
import { sceneContentSchema, sceneDurationIssue, sceneMotionSchema } from "./timed-edits";

export const sceneTemplateRoleSchema = z.enum(["inline", "intro", "outro"]);
export const sceneTemplateDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  durationSec: z.number().finite().min(0.1).max(120),
  content: sceneContentSchema,
  motion: sceneMotionSchema,
}).superRefine((definition, context) => {
  const issue = sceneDurationIssue(definition.content, definition.durationSec);
  if (issue) context.addIssue({ code: "custom", path: ["durationSec"], message: issue });
});

export const sceneTemplateCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  role: sceneTemplateRoleSchema,
  definition: sceneTemplateDefinitionSchema,
  makeDefault: z.boolean().default(false),
});

export const sceneTemplateUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(120).optional(),
  role: sceneTemplateRoleSchema.optional(),
  definition: sceneTemplateDefinitionSchema.optional(),
  makeDefault: z.boolean().optional(),
});

export const sceneTemplateDeleteSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});

export const applySceneTemplateSchema = z.strictObject({
  templateFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  placement: z.enum(["start", "end"]),
  clips: z.array(z.strictObject({
    clipId: z.string().uuid(),
    expectedEditorRevision: z.number().int().nonnegative(),
  })).min(1).max(100),
}).superRefine((value, context) => {
  if (new Set(value.clips.map((clip) => clip.clipId)).size !== value.clips.length) {
    context.addIssue({ code: "custom", path: ["clips"], message: "A clip can appear only once" });
  }
});

export type SceneTemplateDefinition = z.infer<typeof sceneTemplateDefinitionSchema>;
export type SceneTemplateRole = z.infer<typeof sceneTemplateRoleSchema>;
export type SceneTemplateCreateInput = z.infer<typeof sceneTemplateCreateSchema>;
export type SceneTemplateUpdateInput = z.infer<typeof sceneTemplateUpdateSchema>;
export type SceneTemplateDeleteInput = z.infer<typeof sceneTemplateDeleteSchema>;
export type ApplySceneTemplateInput = z.infer<typeof applySceneTemplateSchema>;
