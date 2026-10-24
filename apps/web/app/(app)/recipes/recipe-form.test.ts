import { describe, expect, test } from "bun:test";
import { buildGenerationContentPack, finishingSettingsSchema, type RecipeSnapshot } from "@narriflow/validators";
import { describeRecipeGeneration, describeRecipeWarnings, draftFromRecipe, emptyRecipeDraft, recipeChanges, recipeFromDraft } from "./recipe-form";

const BRAND_PROFILE_ID = "00000000-0000-4000-8000-0000000000b1";

function recipe(overrides: Partial<RecipeSnapshot> = {}): RecipeSnapshot {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    workspaceId: "00000000-0000-4000-8000-0000000000c1",
    name: "Weekly show",
    revision: 2,
    brandProfileId: BRAND_PROFILE_ID,
    languageCode: "en",
    contentPack: buildGenerationContentPack({ clipCountTarget: 6, defaultAspectRatio: "1:1" }),
    finishing: null,
    ruleCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Recipe form", () => {
  test("a blank form starts from the Workspace default Brand Profile and saves the default generation settings", () => {
    const draft = { ...emptyRecipeDraft(BRAND_PROFILE_ID), name: "  Weekly show  " };
    const result = recipeFromDraft(draft);
    if ("error" in result) throw new Error(result.error);
    expect(result.input).toMatchObject({ name: "Weekly show", brandProfileId: BRAND_PROFILE_ID, languageCode: null, finishing: null });
    expect(result.input.contentPack).toMatchObject({ clipCountTarget: 10, defaultAspectRatio: "9:16", clipLengthPreset: "auto", autoHook: true });
  });

  test("an edit opens as the saved draft and round-trips to the same settings", () => {
    const saved = recipe({ finishing: finishingSettingsSchema.parse({ topClips: 2 }) });
    const result = recipeFromDraft(draftFromRecipe(saved), saved.contentPack);
    if ("error" in result) throw new Error(result.error);
    expect(recipeChanges(result.input, saved, false)).toEqual({});
  });

  test("opening finishing that saved no export format is not an edit of it", () => {
    const saved = recipe({ finishing: finishingSettingsSchema.parse({ topClips: 2 }) });
    const opened = draftFromRecipe(saved);
    const result = recipeFromDraft({ ...opened, name: "Renamed" }, saved.contentPack);
    if ("error" in result) throw new Error(result.error);
    expect(recipeChanges(result.input, saved, false)).toEqual({ name: "Renamed" });
    // Turning a field in the finishing section is.
    const edited = recipeFromDraft({ ...opened, finishing: { ...opened.finishing, topClips: "4" } }, saved.contentPack);
    if ("error" in edited) throw new Error(edited.error);
    expect(recipeChanges(edited.input, saved, true)).toMatchObject({ finishing: { topClips: 4 } });
  });

  test("changing the clip length replaces the duration range; leaving it keeps a hand-tuned one", () => {
    const tuned = recipe({ contentPack: { ...buildGenerationContentPack(), maxDurationSec: 80, preferredMaxDurationSec: 70 } });
    const kept = recipeFromDraft(draftFromRecipe(tuned), tuned.contentPack);
    if ("error" in kept) throw new Error(kept.error);
    expect(kept.input.contentPack).toMatchObject({ maxDurationSec: 80, preferredMaxDurationSec: 70 });

    const changed = recipeFromDraft({ ...draftFromRecipe(tuned), clipLengthPreset: "under_30s" }, tuned.contentPack);
    if ("error" in changed) throw new Error(changed.error);
    expect(changed.input.contentPack).toMatchObject({ clipLengthPreset: "under_30s", maxDurationSec: 35, preferredMaxDurationSec: 30 });
  });

  test("says what to fix instead of sending a bad Recipe", () => {
    const draft = emptyRecipeDraft(null);
    expect(recipeFromDraft({ ...draft, name: " " })).toEqual({ error: "Recipe name is required." });
    expect(recipeFromDraft({ ...draft, name: "Show", clipCountTarget: "2" })).toEqual({ error: "Clips per video must be between 3 and 30." });
    expect(recipeFromDraft({ ...draft, name: "Show", finishing: { ...draft.finishing, enabled: true, topClips: "0" } })).toEqual({ error: "Finish between 1 and 10 clips per video." });
  });

  test("a PATCH carries only the fields the form changed", () => {
    const saved = recipe();
    const draft = { ...draftFromRecipe(saved), name: "Renamed", brandProfileId: null };
    const result = recipeFromDraft(draft, saved.contentPack);
    if ("error" in result) throw new Error(result.error);
    expect(recipeChanges(result.input, saved, false)).toEqual({ name: "Renamed", brandProfileId: null });
  });

  test("a save's warning names the rules that will finish without proposing posts", () => {
    expect(describeRecipeWarnings([])).toBeNull();
    const message = describeRecipeWarnings([{ code: "rules_cannot_propose", ruleIds: ["00000000-0000-4000-8000-0000000000a1"], ruleNames: ["Member's rule", "Other rule"] }]);
    expect(message).toContain("Member's rule, Other rule can't propose posts");
    expect(message).toContain("still export clips and write copy");
  });

  test("a card line names the clip count, format, length, and language", () => {
    const label = (code: string | null) => (code === "en" ? "English" : "Auto-detect language");
    expect(describeRecipeGeneration(recipe(), label)).toBe("6 clips · 1:1 · English");
    expect(describeRecipeGeneration(recipe({ languageCode: null, contentPack: buildGenerationContentPack({ clipLengthPreset: "30_to_60s" }) }), label)).toBe("10 clips · 9:16 · 30 to 60s · Auto-detect language");
  });
});
