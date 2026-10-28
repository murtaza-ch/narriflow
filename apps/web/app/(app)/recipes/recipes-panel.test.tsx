import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { buildGenerationContentPack, finishingSettingsSchema, type RecipeSnapshot } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {} }),
}));
const { RecipesPanel } = await import("./recipes-panel");

const BRAND_PROFILE_ID = "00000000-0000-4000-8000-0000000000b1";

function recipe(overrides: Partial<RecipeSnapshot> = {}): RecipeSnapshot {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    workspaceId: "00000000-0000-4000-8000-0000000000c1",
    name: "Weekly show",
    revision: 1,
    brandProfileId: BRAND_PROFILE_ID,
    languageCode: "en",
    contentPack: buildGenerationContentPack(),
    finishing: null,
    ruleCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function render(recipes: RecipeSnapshot[], options: { canEdit?: boolean; finishingAvailable?: boolean } = {}) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <RecipesPanel
        initialRecipes={recipes}
        brandProfiles={[{ id: BRAND_PROFILE_ID, name: "Acme", isDefault: true }]}
        canEdit={options.canEdit ?? true}
        finishingAvailable={options.finishingAvailable ?? true}
        queueAccounts={[]}
      />
    </ChakraProvider>,
  );
}

describe("Recipes panel", () => {
  test("lists each Recipe with its settings, Brand Profile, and where it is used", () => {
    const html = render([recipe({ ruleCount: 2 })]);
    expect(html).toContain("Weekly show");
    for (const setting of ["10 clips", "9:16", "English"]) expect(html).toContain(setting);
    expect(html).toContain("Brand: Acme");
    expect(html).toContain("Used by 2 Autopilot rules");
    expect(html).toContain("Edit Recipe Weekly show");
    expect(html).toContain("Duplicate Recipe Weekly show");
  });

  test("a Recipe an Autopilot rule uses can't be deleted; an unused one can", () => {
    const used = render([recipe({ ruleCount: 1 })]);
    expect(used).toMatch(/<button[^>]*aria-label="Delete Recipe Weekly show"[^>]*disabled/);
    // The reason is visible text, not just a tooltip, and the rules are a link away.
    expect(used).toContain("move it to another Recipe to delete this one");
    expect(used).toContain('href="/autopilot"');
    const unused = render([recipe({ ruleCount: 0 })]);
    expect(unused).not.toMatch(/<button[^>]*aria-label="Delete Recipe Weekly show"[^>]*disabled/);
    expect(unused).toContain("Not used by an Autopilot rule");
  });

  test("a Recipe whose Brand Profile is gone says so, and finishing says it is off below Pro", () => {
    const finishing = finishingSettingsSchema.parse({ topClips: 3 });
    const html = render([recipe({ brandProfileId: "00000000-0000-4000-8000-0000000000b2", finishing })], { finishingAvailable: false });
    expect(html).toContain("Brand: Unavailable Brand Profile");
    expect(html).toContain("Finishing is off: it needs the Pro plan.");
    expect(render([recipe({ finishing })])).toContain("Finishing: top 3 clips");
  });

  test("viewers read Recipes without edit controls, and an empty Workspace is invited to make one", () => {
    const viewer = render([recipe()], { canEdit: false });
    expect(viewer).toContain("Weekly show");
    expect(viewer).not.toContain("Edit Recipe Weekly show");
    expect(viewer).not.toContain("New Recipe");
    const empty = render([]);
    expect(empty).toContain("Reuse your settings on every new video");
    expect(empty).toContain("Create your first Recipe");
    expect(empty).toContain('href="/docs/recipes"');
    // A viewer still learns what Recipes are, with no create action.
    const emptyViewer = render([], { canEdit: false });
    expect(emptyViewer).toContain("How Recipes work");
    expect(emptyViewer).not.toContain("Create your first Recipe");
  });
});
