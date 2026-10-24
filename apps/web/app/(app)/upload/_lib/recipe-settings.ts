import type { RecipeSnapshot } from "@narriflow/validators";
import type { LinkConfigureState } from "./link-content-pack";

/** What choosing a Recipe fills into the setup form. The form still submits
 * its own explicit settings, so every field stays editable afterwards; the
 * Recipe is never sent. The processing range is a property of one source, and
 * the export format is chosen at submit time, so neither is filled. */
export interface RecipeFormSettings {
  /** "auto" detects the source language. */
  languageCode: string;
  brandProfileId: string | null;
  /** The clip settings, in the shape the link flow's Configure step holds. */
  clip: Omit<LinkConfigureState, "processingStartSec" | "processingEndSec">;
}

export function recipeFormSettings(recipe: Pick<RecipeSnapshot, "languageCode" | "brandProfileId" | "contentPack">): RecipeFormSettings {
  const pack = recipe.contentPack;
  return {
    languageCode: recipe.languageCode ?? "auto",
    brandProfileId: recipe.brandProfileId,
    clip: {
      mode: pack.mode,
      clipLengthPreset: pack.clipLengthPreset,
      captionPreset: pack.captionPreset,
      defaultAspectRatio: pack.defaultAspectRatio,
      autoHook: pack.autoHook,
      specificMoments: pack.specificMoments,
      platformTargets: pack.platformTargets,
      clipCountTarget: pack.clipCountTarget,
      toneConstraints: pack.toneConstraints.join(", "),
    },
  };
}
