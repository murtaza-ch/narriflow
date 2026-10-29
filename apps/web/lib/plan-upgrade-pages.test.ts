import { expect, test } from "bun:test";
import {
  hasFeature,
  planCountRequirement,
  planFeatureRequirement,
  type PricingTier,
} from "@narriflow/validators";
import {
  deriveProjectView,
  type ProjectDetailData,
  type ProjectRecord,
} from "../app/(app)/projects/[projectId]/project-view-model";

// What the Brand Kit and Project screens promise a Free Workspace they offer for
// purchase must be a plan that really unlocks the action. The screens render the
// requirement the API sends (Brand Kit: `styleCreateRequirement`) or derive it from
// the Project detail (`deriveProjectView`); both are exercised here at that seam.

/** The API's rule for creating one more caption style: the count limit, else the feature. */
function styleCreateRequirement(tier: PricingTier, retainedStyles: number) {
  return planCountRequirement(tier, "brandTemplates", retainedStyles) ?? planFeatureRequirement(tier, "brand.customTemplates");
}

for (const [count, expectedTier] of [[0, "creator"], [3, "pro"], [10, "business"], [30, null]] as const) {
  test(`style creation accounts for ${count} retained styles on Free`, () => {
    const requirement = styleCreateRequirement("free", count);
    expect(requirement?.requiredTier ?? null).toBe(expectedTier);
    if (expectedTier) {
      expect(planFeatureRequirement(expectedTier, "brand.customTemplates")).toBeNull();
      expect(hasFeature(expectedTier, "brand.customTemplates")).toBe(true);
      expect(planCountRequirement(expectedTier, "brandTemplates", count)).toBeNull();
    } else {
      // No plan raises the limit: the screen says so and offers no purchase.
      expect(requirement?.message).toBeTruthy();
    }
  });
}

type CreditUsage = { periodStart: string; spentCredits: number; state: "reserved" | "released" | "settled" | "refunded" } | null;

function projectView(sourceSeconds: number | null, creditUsage: CreditUsage) {
  const project = {
    id: "project", title: "Measured source", ingestStatus: "ready", ingestErrorCode: null, sourceType: "link",
    sourceInput: null, sourceMediaUrl: "r2://source", sourceStorageKey: "source", sourceDurationSeconds: sourceSeconds,
    languageCode: null, notifyOnComplete: false, brandProfileId: null,
  } as unknown as ProjectRecord;
  const data = {
    tab: "clips",
    access: { role: "owner", status: "active", pricingTier: "free", isPersonalWorkspace: true },
    snapshot: {
      project, progress: { active: false, status: "pending", label: "Ready" }, activeRun: null, lastSeq: 0,
      ingestAttemptCount: 0, ingestJobType: "ingest",
    },
    transcript: { view: "status", data: null },
    clips: [],
    contentPack: null,
    socialPosts: { items: [], nextCursor: null },
    workflowHistory: [],
    usage: {
      tier: "free", remainingCredits: 60, limitCredits: 60, maxUploadSeconds: 3600, renewsAt: "2026-11-01T00:00:00.000Z",
    },
    finishing: null,
    creditUsage,
    tabData: {},
  } as unknown as ProjectDetailData;
  return deriveProjectView(data, project);
}

const reserved = (spentCredits: number, state: NonNullable<CreditUsage>["state"] = "reserved"): CreditUsage =>
  ({ periodStart: "2026-09-01T00:00:00.000Z", spentCredits, state });

for (const scenario of [
  { spent: 1000, expectedTier: "business" },
  { spent: 0, expectedTier: "creator" },
  { spent: 230, expectedTier: "creator" },
  { spent: 1739, expectedTier: "business" },
] as const) {
  test(`transcription offers ${scenario.expectedTier} with ${scenario.spent} credits already spent in the settlement period`, () => {
    expect(projectView(61 * 60, reserved(scenario.spent)).lengthUpgrade?.tier).toBe(scenario.expectedTier);
  });
}

test("unknown duration or missing ledger facts cannot promise a source-specific purchase", () => {
  for (const [seconds, credits] of [[null, reserved(0)], [0, reserved(0)], [3660, null]] as const) {
    expect(projectView(seconds, credits).lengthUpgrade).toBeNull();
  }
});

// Settlement returns early for a settled or refunded Project, so its retry needs
// neither the length nor the credits, and the page must not block or sell them.
for (const [state, blocked] of [["reserved", true], ["released", true], ["settled", false], ["refunded", false]] as const) {
  test(`a ${state} Project ${blocked ? "keeps" : "drops"} the length block and upgrade offer`, () => {
    const view = projectView(61 * 60, reserved(0, state));
    expect(view.planLimitMessage === null).toBe(!blocked);
    expect(view.lengthUpgrade?.tier ?? null).toBe(blocked ? "creator" : null);
  });
}
