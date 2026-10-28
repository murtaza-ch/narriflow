import {
  buildGenerationContentPack,
  clipLengthPresetRanges,
  contentPackSchema,
  recipeInputSchema,
  type ClipLengthPreset,
  type ContentPack,
  type RecipeSnapshot,
  type RecipeWarning,
} from "@narriflow/validators";
import {
  draftFromFinishing,
  EMPTY_FINISHING_DRAFT,
  finishingFromDraft,
  type FinishingDraft,
} from "./finishing-form";

/** A Recipe input as the shared schema parses it: what the API's create and update accept. */
export type ParsedRecipeInput = ReturnType<typeof recipeInputSchema.parse>;

/** The Recipe form. Numbers stay strings while the person types;
 * `recipeFromDraft` turns the draft into the shared input, or says what to fix.
 * Content Pack settings the form doesn't show carry over from the pack being
 * edited, so a Recipe made elsewhere keeps them. */
export interface RecipeDraft {
  name: string;
  brandProfileId: string | null;
  /** "auto" detects the source language. */
  languageCode: string;
  clipCountTarget: string;
  clipLengthPreset: ClipLengthPreset;
  defaultAspectRatio: ContentPack["defaultAspectRatio"];
  autoHook: boolean;
  finishing: FinishingDraft;
}

export function emptyRecipeDraft(defaultBrandProfileId: string | null): RecipeDraft {
  return {
    name: "",
    brandProfileId: defaultBrandProfileId,
    languageCode: "auto",
    clipCountTarget: "10",
    clipLengthPreset: "auto",
    defaultAspectRatio: "9:16",
    autoHook: true,
    finishing: EMPTY_FINISHING_DRAFT,
  };
}

export function draftFromRecipe(recipe: RecipeSnapshot): RecipeDraft {
  return {
    name: recipe.name,
    brandProfileId: recipe.brandProfileId,
    languageCode: recipe.languageCode ?? "auto",
    clipCountTarget: String(recipe.contentPack.clipCountTarget),
    clipLengthPreset: recipe.contentPack.clipLengthPreset,
    defaultAspectRatio: recipe.contentPack.defaultAspectRatio,
    autoHook: recipe.contentPack.autoHook,
    finishing: draftFromFinishing(recipe.finishing),
  };
}

export function recipeFromDraft(
  draft: RecipeDraft,
  /** The pack being edited; a new Recipe starts from the defaults. */
  base: ContentPack = buildGenerationContentPack(),
): { input: ParsedRecipeInput } | { error: string } {
  if (!draft.name.trim()) return { error: "Recipe name is required." };
  const clipCountTarget = Number(draft.clipCountTarget);
  if (!Number.isInteger(clipCountTarget) || clipCountTarget < 3 || clipCountTarget > 30) {
    return { error: "Clips per video must be between 3 and 30." };
  }
  const finishing = finishingFromDraft(draft.finishing);
  if ("error" in finishing) return { error: finishing.error };
  // A new length preset replaces the duration range it implies; an unchanged
  // one keeps the range already saved, which may have been tuned by hand.
  const durations = draft.clipLengthPreset === base.clipLengthPreset ? {} : clipLengthPresetRanges[draft.clipLengthPreset];
  const contentPack = contentPackSchema.safeParse({
    ...base,
    ...durations,
    clipCountTarget,
    clipLengthPreset: draft.clipLengthPreset,
    defaultAspectRatio: draft.defaultAspectRatio,
    autoHook: draft.autoHook,
  });
  if (!contentPack.success) return { error: "These generation settings are not valid together." };
  const input = recipeInputSchema.safeParse({
    name: draft.name.trim(),
    brandProfileId: draft.brandProfileId,
    languageCode: draft.languageCode === "auto" ? null : draft.languageCode,
    contentPack: contentPack.data,
    finishing: finishing.settings,
  });
  return input.success ? { input: input.data } : { error: "Recipe settings are invalid." };
}

/** The fields a form changed on a saved Recipe: all a PATCH needs to send.
 * Finishing is compared as the person left it: opening the form fills in
 * defaults (such as an explicit export format) that must not count as an edit. */
export function recipeChanges(input: ParsedRecipeInput, recipe: RecipeSnapshot, finishingEdited: boolean) {
  const differs = (next: unknown, current: unknown) => JSON.stringify(next ?? null) !== JSON.stringify(current ?? null);
  return {
    ...(input.name !== recipe.name && { name: input.name }),
    ...(input.brandProfileId !== recipe.brandProfileId && { brandProfileId: input.brandProfileId }),
    ...(differs(input.languageCode, recipe.languageCode) && { languageCode: input.languageCode }),
    ...(differs(input.contentPack, recipe.contentPack) && { contentPack: input.contentPack }),
    ...(finishingEdited && differs(input.finishing, recipe.finishing) && { finishing: input.finishing }),
  };
}

/** What a save tells the person about rules that use the Recipe, or null. */
export function describeRecipeWarnings(warnings: RecipeWarning[]): string | null {
  const names = warnings.flatMap((warning) => (warning.code === "rules_cannot_propose" ? warning.ruleNames : []));
  if (names.length === 0) return null;
  return `${names.join(", ")} can't propose posts to the queue, because the member each one runs as can't manage publishing. They still export clips and write copy. A Workspace Owner or Admin can take a rule over from the Autopilot page.`;
}

/** One line for a Recipe card, such as "10 clips · 9:16 · English". */
export function describeRecipeGeneration(recipe: Pick<RecipeSnapshot, "contentPack" | "languageCode">, languageLabel: (code: string | null) => string): string {
  const { clipCountTarget, defaultAspectRatio, clipLengthPreset } = recipe.contentPack;
  const parts = [`${clipCountTarget} clips`, defaultAspectRatio];
  if (clipLengthPreset !== "auto") parts.push(clipLengthPreset.replaceAll("_", " "));
  parts.push(languageLabel(recipe.languageCode));
  return parts.join(" · ");
}
