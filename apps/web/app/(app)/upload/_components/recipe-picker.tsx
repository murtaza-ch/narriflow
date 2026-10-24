"use client";

import { useState } from "react";
import Link from "next/link";
import { Stack, Text } from "@chakra-ui/react";
import { BookMarked } from "lucide-react";
import { Select } from "@narriflow/ui/components/select";
import type { RecipeSnapshot } from "@narriflow/validators";
import { recipeFormSettings, type RecipeFormSettings } from "../_lib/recipe-settings";

/** Fills the setup form from a saved Recipe. It only prefills: the form below
 * stays editable, and what is submitted is the form's own settings. */
export function RecipePicker({
  recipes,
  onApply,
}: {
  recipes: Array<Pick<RecipeSnapshot, "id" | "name" | "languageCode" | "brandProfileId" | "contentPack" | "finishing">>;
  onApply: (settings: RecipeFormSettings) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  if (recipes.length === 0) return null;
  const recipe = recipes.find((entry) => entry.id === chosen);
  return (
    <Stack gap="1.5">
      <Select
        ariaLabel="Recipe"
        startElement={<BookMarked size={16} strokeWidth={1.75} />}
        items={recipes.map((entry) => ({ label: entry.name, value: entry.id }))}
        value={chosen ?? undefined}
        onValueChange={(id) => {
          const next = recipes.find((entry) => entry.id === id);
          if (!next) return;
          setChosen(id);
          onApply(recipeFormSettings(next));
        }}
        placeholder="Start from a Recipe"
        size="md"
      />
      <Text fontSize="12px" color="fg.muted">
        {recipe ? `Settings filled in from ${recipe.name}. Change anything before you start. ` : "Fill in your saved settings. "}
        <Link href="/recipes">Manage Recipes</Link>
      </Text>
      {recipe?.finishing ? (
        <Text fontSize="12px" color="fg.muted">
          This Recipe also finishes new clips automatically. Imports started here don't do that; Autopilot, the API and your assistants do.
        </Text>
      ) : null}
    </Stack>
  );
}
