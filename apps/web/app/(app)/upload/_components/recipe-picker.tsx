"use client";

import { useState } from "react";
import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { BookMarked, Captions, Info } from "lucide-react";
import { Select } from "@narriflow/ui/components/select";
import type { RecipeSnapshot } from "@narriflow/validators";
import { LANGUAGE_OPTIONS } from "../../_shared/languages";
import { recipeFormSettings, type RecipeFormSettings } from "../_lib/recipe-settings";
import { RatioIcon } from "./format-settings";

type PickerRecipe = Pick<RecipeSnapshot, "id" | "name" | "languageCode" | "brandProfileId" | "contentPack" | "finishing">;

function languageName(code: string | null) {
  const option = LANGUAGE_OPTIONS.find((entry) => entry.code === (code ?? "auto"));
  return option?.label.split(" · ")[0] ?? code ?? "Auto-detect";
}

/** What a Recipe fills in, in one line: its language and what it makes. */
function recipeSummary(recipe: PickerRecipe) {
  const pack = recipe.contentPack;
  return [
    languageName(recipe.languageCode),
    pack.mode === "clip" ? `AI clips · ${pack.defaultAspectRatio}` : "Caption only",
  ].join(" · ");
}

/** The Recipe's output drawn small: its format's shape for clips, a caption mark otherwise. */
function RecipeMark({ recipe }: { recipe: PickerRecipe }) {
  return (
    <Box w="32px" h="26px" display="flex" alignItems="center" justifyContent="center" color="fg.muted">
      {recipe.contentPack.mode === "clip" ? (
        <RatioIcon ratio={recipe.contentPack.defaultAspectRatio} />
      ) : (
        <Captions size={16} strokeWidth={1.75} />
      )}
    </Box>
  );
}

const linkStyle = {
  color: "accent.fg",
  fontWeight: "500",
  textDecoration: "underline",
  textDecorationColor: "transparent",
  textUnderlineOffset: "3px",
  transition: "text-decoration-color 120ms ease",
  _hover: { textDecorationColor: "currentColor" },
} as const;

/** Fills the setup form from a saved Recipe. It only prefills: the form below
 * stays editable, and what is submitted is the form's own settings. */
export function RecipePicker({
  recipes,
  onApply,
}: {
  recipes: PickerRecipe[];
  onApply: (settings: RecipeFormSettings) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  if (recipes.length === 0) return null;
  const recipe = recipes.find((entry) => entry.id === chosen);
  return (
    <Stack gap="2">
      <Select
        ariaLabel="Recipe"
        startElement={<BookMarked size={16} strokeWidth={1.75} />}
        items={recipes.map((entry) => ({
          label: entry.name,
          value: entry.id,
          description: recipeSummary(entry),
          icon: <RecipeMark recipe={entry} />,
        }))}
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
      <Text fontSize="12px" color="fg.muted" lineHeight="1.5">
        {recipe ? `Settings filled in from ${recipe.name}. Change anything before you start. ` : "Fill in your saved settings. "}
        <Link href="/recipes">
          <Text as="span" {...linkStyle}>
            Manage Recipes
          </Text>
        </Link>
      </Text>
      {recipe?.finishing ? (
        <Flex align="flex-start" gap="2" px="3" py="2.5" borderRadius="l2" bg="bg.soft" color="fg.muted">
          <Box mt="0.5" flexShrink={0}>
            <Info size={13} aria-hidden />
          </Box>
          <Text fontSize="12px" lineHeight="1.5">
            This Recipe also finishes new clips automatically. Imports started here don't do that; Autopilot, the API and your assistants do.
          </Text>
        </Flex>
      ) : null}
    </Stack>
  );
}
