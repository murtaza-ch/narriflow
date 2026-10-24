import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { buildGenerationContentPack, finishingSettingsSchema, type AutopilotRuleSnapshot, type RecipeSnapshot } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {} }),
}));
const { AutopilotPanel, RecipeSelect } = await import("./autopilot-panel");
const { BrandProfileSelect } = await import("../recipes/brand-profile-select");
const { FinishingFields } = await import("../recipes/finishing-fields");
const { EMPTY_FINISHING_DRAFT } = await import("../recipes/finishing-form");
type AutopilotRuleGrant = import("./autopilot-panel").AutopilotRuleGrant;

const BRAND_PROFILE_ID = "00000000-0000-4000-8000-0000000000b1";
const RECIPE_ID = "00000000-0000-4000-8000-0000000000e1";

function recipe(overrides: Partial<RecipeSnapshot> = {}): RecipeSnapshot {
  return {
    id: RECIPE_ID,
    workspaceId: "00000000-0000-4000-8000-0000000000c1",
    name: "Weekly show",
    revision: 1,
    brandProfileId: BRAND_PROFILE_ID,
    languageCode: null,
    contentPack: buildGenerationContentPack(),
    finishing: null,
    ruleCount: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function rule(overrides: Partial<AutopilotRuleSnapshot>): AutopilotRuleSnapshot {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    workspaceId: "00000000-0000-4000-8000-0000000000c1",
    createdByUserId: null,
    name: "Weekly show",
    rssUrl: "https://feeds.example.test/show.xml",
    titlePrefix: null,
    recipeId: RECIPE_ID,
    recipeName: "Weekly show",
    intervalMinutes: 1440,
    maxEpisodesPerRun: 3,
    feedTitle: null,
    initialImportMode: "future_only",
    initialImportCount: 3,
    status: "active",
    pauseKind: null,
    lastCheckedAt: null,
    lastSuccessAt: null,
    nextRunAt: "2026-10-25T00:00:00.000Z",
    lastError: null,
    consecutiveFailures: 0,
    importedEpisodeCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function render(rules: AutopilotRuleSnapshot[], canTakeOver: boolean, finishingAvailable = true, recipes = [recipe()], grants: AutopilotRuleGrant[] = []) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <AutopilotPanel
        initialRules={rules}
        recipes={recipes}
        canTakeOver={canTakeOver}
        finishingAvailable={finishingAvailable}
        grants={grants}
      />
    </ChakraProvider>,
  );
}

const PAUSE_REASON =
  "Dana Lee can no longer run this rule. A Workspace Owner or Admin can take it over to resume it.";

describe("Autopilot panel ownership and Recipe", () => {
  test("a paused rule shows its reason, and only Owners and Admins get Take over", () => {
    const paused = rule({ status: "paused", pauseKind: "acting_member", lastError: PAUSE_REASON });
    const asAdmin = render([paused], true);
    expect(asAdmin).toContain(PAUSE_REASON);
    expect(asAdmin).toContain("Take over");
    expect(asAdmin).not.toContain("Last run failed");

    const asMember = render([paused], false);
    expect(asMember).toContain(PAUSE_REASON);
    expect(asMember).not.toContain("Take over");
  });

  test("a Brand Profile pause shows its reason but offers no takeover, since another profile fixes it", () => {
    const reason = "Brand Profile \"Acme\" could not be applied: Brand Profile not found. Fix it in Brand Kit or in the rule's Recipe, then turn the rule back on. Moving the rule to another Recipe also resumes it.";
    const html = render([rule({ status: "paused", pauseKind: "brand_profile", lastError: reason })], true);
    expect(html).toContain("could not be applied");
    expect(html).not.toContain("Take over");
    expect(html).toContain("Edit rule Weekly show");
  });

  test("a failed rule keeps the failure block and offers no takeover; the rule names its Recipe", () => {
    const html = render([rule({ status: "failed", lastError: "feed unreachable", consecutiveFailures: 8 })], true);
    expect(html).toContain("Last run failed");
    expect(html).not.toContain("Take over");
    expect(html).toContain("Recipe: Weekly show");
  });

  test("the Recipe picker lists the Recipes, and a Workspace with none is sent to create one", () => {
    const pick = (recipes: Array<Pick<RecipeSnapshot, "id" | "name">>) =>
      renderToStaticMarkup(
        <ChakraProvider value={system}>
          <RecipeSelect recipes={recipes} value={RECIPE_ID} onChange={() => {}} />
        </ChakraProvider>,
      );
    const chosen = pick([recipe(), recipe({ id: "00000000-0000-4000-8000-0000000000e2", name: "Shorts" })]);
    expect(chosen).toContain("Weekly show");
    expect(chosen).toContain("Manage Recipes");
    // Nothing is chosen for the person: with no value the picker asks for one.
    const unchosen = renderToStaticMarkup(
      <ChakraProvider value={system}>
        <RecipeSelect recipes={[recipe()]} value={null} onChange={() => {}} />
      </ChakraProvider>,
    );
    expect(unchosen).toContain("Choose a Recipe");
    const none = pick([]);
    expect(none).toContain("Create one first");
    expect(none).toContain('href="/recipes"');
  });

  test("the Brand Profile picker offers none, each profile, and flags a profile that is gone", () => {
    const profiles = [{ id: BRAND_PROFILE_ID, name: "Acme", isDefault: true }];
    const pick = (value: string | null, available = profiles) =>
      renderToStaticMarkup(
        <ChakraProvider value={system}>
          <BrandProfileSelect profiles={available} value={value} onChange={() => {}} />
        </ChakraProvider>,
      );
    const chosen = pick(BRAND_PROFILE_ID);
    expect(chosen).toContain("No Brand Profile");
    expect(chosen).toContain("Acme");
    expect(chosen).not.toContain("Unavailable Brand Profile");
    expect(pick("00000000-0000-4000-8000-0000000000b2")).toContain("Unavailable Brand Profile");
    // A Workspace with no profiles gets no picker.
    expect(pick(null, [])).not.toContain("No Brand Profile");
  });

  test("a rule summarizes its Recipe's finishing, and says finishing is off when the plan lacks it", () => {
    const finishing = finishingSettingsSchema.parse({ topClips: 3, minScore: 60, aspectRatios: ["9:16", "1:1"], copyPlatforms: ["tiktok", "x"] });
    const available = render([rule({})], false, true, [recipe({ finishing })]);
    expect(available).toContain("Finishing: top 3 clips · score 60+ · 9:16, 1:1 · copy for TikTok, X");
    expect(available).not.toContain("needs the Pro plan. New episodes");

    const downgraded = render([rule({})], false, false, [recipe({ finishing })]);
    expect(downgraded).toContain("Finishing is off: it needs the Pro plan. New episodes still import and generate clips.");
    expect(downgraded).not.toContain("Finishing: top 3");

    expect(render([rule({})], false)).not.toContain("Finishing:");
  });

  test("a rule shows the automation grants that cover it, and managers get a way to add one", () => {
    const covering: AutopilotRuleGrant[] = [
      { id: "00000000-0000-4000-8000-0000000000d1", ruleId: "00000000-0000-4000-8000-0000000000a1", kind: "publish", status: "active", destination: "Show channel", expiresAt: "2026-11-20T10:00:00.000Z" },
      { id: "00000000-0000-4000-8000-0000000000d2", ruleId: "00000000-0000-4000-8000-0000000000a1", kind: "review_send", status: "paused", destination: "2 reviewers", expiresAt: "2026-11-20T10:00:00.000Z" },
      { id: "00000000-0000-4000-8000-0000000000d3", ruleId: "00000000-0000-4000-8000-0000000000ff", kind: "publish", status: "active", destination: "Other rule's channel", expiresAt: "2026-11-20T10:00:00.000Z" },
    ];
    const asAdmin = render([rule({})], true, true, undefined, covering);
    expect(asAdmin).toContain("Posts to Show channel: until");
    expect(asAdmin).toContain("Reviews by 2 reviewers: paused");
    expect(asAdmin).not.toContain("Other rule&#x27;s channel");
    expect(asAdmin).toContain("/settings/automation-grants?rule=00000000-0000-4000-8000-0000000000a1");
    expect(asAdmin).toContain("Manage grants");

    const asMember = render([rule({})], false, true, undefined, covering);
    expect(asMember).toContain("Posts to Show channel");
    expect(asMember).toContain("View grants");
    expect(asMember).not.toContain("Manage grants");

    // No grant: a manager is told what that means, a member sees nothing extra.
    expect(render([rule({})], true)).toContain("No automation grant: posts and review rounds wait for a person.");
    expect(render([rule({})], false)).not.toContain("automation grant");
  });

});

describe("Finishing fields", () => {
  const fields = (draft: typeof EMPTY_FINISHING_DRAFT, available: boolean) =>
    renderToStaticMarkup(
      <ChakraProvider value={system}>
        <FinishingFields idPrefix="test" draft={draft} onChange={() => {}} available={available} />
      </ChakraProvider>,
    );

  test("off shows only the switch; on shows the clip count, score, formats and copy platforms", () => {
    const off = fields(EMPTY_FINISHING_DRAFT, true);
    expect(off).toContain("Finish new clips automatically");
    expect(off).not.toContain("Top clips");
    const on = fields({ ...EMPTY_FINISHING_DRAFT, enabled: true, copyPlatforms: ["tiktok"] }, true);
    for (const text of ["Top clips", "Minimum score", "Export formats", "Vertical 9:16", "Write copy for", "TikTok", "YouTube Shorts"]) expect(on).toContain(text);
    expect(on).not.toContain("needs the Pro plan");
  });

  test("below Pro the switch is disabled and the reason is shown, even for a Recipe that had it on", () => {
    const creator = fields(EMPTY_FINISHING_DRAFT, false);
    expect(creator).toContain("Finishing needs the Pro plan. Videos still import and generate clips without it.");
    expect(creator).toContain("disabled");
    // A downgraded Recipe's saved settings stay hidden until the plan returns.
    expect(fields({ ...EMPTY_FINISHING_DRAFT, enabled: true }, false)).not.toContain("Top clips");
  });
});
