import { describe, expect, test } from "bun:test";
import { planLimits } from "@narriflow/validators";
import { dubAllowanceUpgradePrompt, featureUpgradePrompt } from "./feature-upgrade-prompt";

describe("featureUpgradePrompt", () => {
  test("names the cheapest plan with the first missing feature", () => {
    const prompt = featureUpgradePrompt("free", ["campaign.operations", "export.bundles"], "Upgrade");
    expect(prompt?.tier).toBe("pro");
    expect(prompt?.headline).toBe("Upgrade");
    expect(prompt?.highlight).toBeTruthy();
  });

  test("is null once the plan has every feature", () => {
    expect(featureUpgradePrompt("pro", ["campaign.operations", "export.bundles"], "Upgrade")).toBeNull();
  });

  test("skips features the plan already has", () => {
    expect(featureUpgradePrompt("creator", ["publishing.assistedCopy", "publishing.customThumbnails"], "Upgrade")?.tier).toBe("pro");
  });
});

describe("dubAllowanceUpgradePrompt", () => {
  test("offers a plan with room for one more dub, and nothing when none has", () => {
    expect(dubAllowanceUpgradePrompt("pro", 10)).toMatchObject({ tier: "business", highlight: "30 dubs a month" });
    expect(dubAllowanceUpgradePrompt("business", 30)).toBeNull();
  });

  test("after a downgrade the offered plan admits the next dub", () => {
    // Pro after 30 dubs on Business: Business's 30 is already spent, so no plan qualifies.
    expect(dubAllowanceUpgradePrompt("pro", 30)).toBeNull();
    // Pro after 12 dubs: Pro's 10 are gone and Business's 30 has room.
    const prompt = dubAllowanceUpgradePrompt("pro", 12);
    expect(prompt?.tier).toBe("business");
    expect(planLimits(prompt?.tier).dubs.perMonth).toBeGreaterThanOrEqual(12 + 1);
  });
});
