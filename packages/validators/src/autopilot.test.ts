import { describe, expect, test } from "bun:test";
import { autopilotRuleInputSchema, autopilotRuleUpdateSchema } from "./autopilot";

const RECIPE_ID = "00000000-0000-4000-8000-0000000000e1";

describe("Autopilot rule schemas", () => {
  test("a rule needs a Recipe and carries none of the settings a Recipe holds", () => {
    const rule = { name: "Weekly show", rssUrl: "https://feeds.example.test/show.xml" };
    expect(autopilotRuleInputSchema.safeParse(rule).success).toBe(false);
    for (const inline of [{ brandProfileId: null }, { languageCode: "en" }, { contentPack: {} }, { finishing: null }]) {
      expect(autopilotRuleInputSchema.safeParse({ ...rule, recipeId: RECIPE_ID, ...inline }).success).toBe(false);
    }
  });

  test("create fills the schedule defaults", () => {
    expect(
      autopilotRuleInputSchema.parse({
        name: "Weekly show",
        rssUrl: "https://feeds.example.test/show.xml",
        recipeId: RECIPE_ID,
      }),
    ).toMatchObject({
      intervalMinutes: 1440,
      maxEpisodesPerRun: 3,
      initialImportMode: "future_only",
      initialImportCount: 3,
    });
  });

  test("a partial update sends only what the caller changed", () => {
    expect(autopilotRuleUpdateSchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
    expect(autopilotRuleUpdateSchema.parse({ status: "paused" })).toEqual({ status: "paused" });
    expect(autopilotRuleUpdateSchema.parse({ recipeId: RECIPE_ID })).toEqual({ recipeId: RECIPE_ID });
    expect(autopilotRuleUpdateSchema.safeParse({ brandProfileId: null }).success).toBe(false);
    expect(autopilotRuleUpdateSchema.safeParse({ intervalMinutes: 10 }).success).toBe(false);
    expect(autopilotRuleUpdateSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});
