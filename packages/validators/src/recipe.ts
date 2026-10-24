import { z } from "zod";
import { contentPackSchema } from "./content-pack";
import { finishingSettingsSchema } from "./finishing";
import { sourceLanguageCodeSchema } from "./language";

/** A Recipe is a named, revisioned set of Workspace settings: Brand Profile,
 * source language, Content Pack, and finishing. Autopilot rules and
 * integration requests reference one; work already accepted keeps the
 * settings it froze. */

export const MAX_RECIPES_PER_WORKSPACE = 50;

/** A captioned video carries its own settings, so a Recipe never does. */
export const recipeContentPackSchema = contentPackSchema.refine((pack) => !pack.captionedVideo, {
  path: ["captionedVideo"],
  message: "A Recipe holds clip generation settings, not a captioned video",
});

// Create and update share these fields. Defaults live only on the create
// schema: a partial update must not reset fields it did not send.
const recipeFields = z.object({
  name: z.string().trim().min(1).max(120),
  // Omitted on create means the Workspace default Brand Profile; null means none.
  brandProfileId: z.string().uuid().nullable().optional(),
  // Null means detect the source language.
  languageCode: sourceLanguageCodeSchema.optional(),
  contentPack: recipeContentPackSchema,
  // Null means no finishing; it needs the Pro plan.
  finishing: finishingSettingsSchema.nullable().optional(),
});

export const recipeInputSchema = recipeFields.strict();

export const recipeUpdateSchema = recipeFields
  .partial()
  .extend({
    // The revision the editor read; an edit made on top of another is refused.
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const recipeSnapshotSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  revision: z.number().int().positive(),
  brandProfileId: z.string().uuid().nullable(),
  languageCode: z.string().nullable(),
  contentPack: contentPackSchema,
  finishing: finishingSettingsSchema.nullable(),
  /** Autopilot rules that import with this Recipe; a Recipe in use can't be deleted. */
  ruleCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Something a saved Recipe change leaves for a person to look at. */
export const recipeWarningSchema = z.object({
  code: z.literal("rules_cannot_propose"),
  /** Autopilot rules using the Recipe whose member can't manage publishing, so they finish without proposing posts. */
  ruleIds: z.array(z.string().uuid()),
  ruleNames: z.array(z.string()),
});
export type RecipeWarning = z.infer<typeof recipeWarningSchema>;
/** A saved Recipe, with any warnings its save raised. Warnings never block the save. */
export type RecipeSaveResult = RecipeSnapshot & { warnings: RecipeWarning[] };

export type RecipeInput = z.input<typeof recipeInputSchema>;
export type RecipeUpdate = z.infer<typeof recipeUpdateSchema>;
export type RecipeSnapshot = z.infer<typeof recipeSnapshotSchema>;
