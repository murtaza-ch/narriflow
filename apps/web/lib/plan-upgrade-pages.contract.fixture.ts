import { beforeAll, expect, mock, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { hasFeature, planFeatureRequirement } from "@narriflow/validators";
import { requirePlanFeature, requireWithinPlanLimit } from "../../../packages/services/src/plan-features";

// Execute the real server pages with page I/O and child components replaced.
// Keep their catalog, upgrade helpers, and production guards intact.
const actor = {
  actorUserId: "owner", workspaceId: "workspace", workspaceOwnerUserId: "owner",
  role: "owner", status: "active", pricingTier: "free", isPersonalWorkspace: true,
  firstName: "Owner", lastName: null, primaryEmail: null, imageUrl: null,
};
let styleCount = 0;
let currentCredits = 0;
let projectCredits: { periodStart: Date; spentCredits: number; state: "reserved" | "released" | "settled" | "refunded" } | null = null;
let sourceSeconds: number | null = 61 * 60;
const noItems = async () => [];
const noValue = async () => null;
mock.module("@/lib/authenticated-request-page", () => ({
  admitWorkspacePage: async () => actor, admitProjectPage: async () => actor,
}));
mock.module("@narriflow/services", () => ({
  hasFeature,
  brandPlanRequirement: (scope: typeof actor, feature: Parameters<typeof planFeatureRequirement>[1]) => planFeatureRequirement(scope.pricingTier, feature),
  brandCountRequirement: () => null,
  brandFontService: { list: noItems },
  brandProfileService: { list: noItems, getDefaultId: noValue, usage: async () => ({}) },
  brandTemplateService: { list: async () => ({ builtIns: [], mine: Array.from({ length: styleCount }, (_, id) => ({ id: String(id) })), defaultId: null }) },


  analyticsService: {},
  clipService: { listClips: noItems },
  dubbingService: {},
  getProcessingUsage: () => ({ projectCreditUsage: async () => projectCredits }),
  getProjectFinishing: noValue,
  isQuotaBlockedMidFlight: () => false,
  MAX_INGEST_RETRY_ATTEMPTS: 3,
  presignDownloadUrl: noValue,
  projectService: {
    getProjectSnapshot: async () => ({
      project: { title: "Measured source", sourceType: "link", sourceInput: null, sourceMediaUrl: "r2://source",
        sourceStorageKey: "source", sourceDurationSeconds: sourceSeconds, ingestStatus: "ready", ingestErrorCode: null,
        createdAt: "2026-09-30T23:59:00Z", expiresAt: null, brandProfileId: null },
      activeRun: null, ingestAttemptCount: 0, lastSeq: 0, progress: { active: false, status: "pending", label: "Ready" },
    }),
    getTranscriptStatusSnapshot: noValue,
    getLatestContentPack: noValue,
    getWorkflowHistory: noItems,
    getUsageSummary: async () => ({ tier: "free", usedCredits: currentCredits, reservedCredits: 0,
      remainingCredits: Math.max(0, 60 - currentCredits), limitCredits: 60, maxUploadSeconds: 3600,
      periodStart: new Date("2026-10-01T00:00:00Z"), renewsAt: new Date("2026-11-01T00:00:00Z") }),
  },
  reviewService: {},
  socialOAuthService: { listAccounts: noItems },
  socialService: { listProjectPosts: async () => ({ items: [], nextCursor: null }) },
  workspaceService: { getWorkspace: noValue },
}));
mock.module("@/lib/review-preselection", () => ({ resolveReviewPreselection: () => null }));

const projectDir = "../app/(app)/projects/[projectId]/";
for (const [file, exports] of [
  ["finishing-status", ["FinishingStatus"]], ["project-events", ["ProjectEvents"]],
  ["source-icon", ["SourceIcon"]], ["project-events-provider", ["ProjectEventsProvider"]],
  ["pipeline-stepper", ["PipelineStepper"]], ["project-tabs", ["ProjectTabs", "TabCountBadge"]],
  ["processing-panel", ["ProcessingPanel"]], ["transcript-panel", ["TranscriptPanel"]],
  ["clips-panel", ["ClipsPanel"]], ["content-suite-panel", ["ContentSuitePanel"]],
  ["analytics-panel", ["AnalyticsPanel"]], ["dubbing-panel", ["DubbingPanel"]],
  ["review-panel", ["ReviewPanel"]], ["project-share-button", ["ProjectShareButton"]],
  ["publishing-provider", ["PublishingProvider", "ProjectPosts"]],
  ["render-clips-button", ["RetryIngestButton"]], ["advanced-clip-settings", ["AdvancedClipSettings"]],
] as const) {
  mock.module(projectDir + file, () => Object.fromEntries(exports.map((name) => [name, () => null])));
}
for (const [file, name] of [
  ["../app/(app)/projects/_components/delete-project-button", "DeleteProjectButton"],
  ["../app/(app)/projects/_components/project-expiration", "ProjectExpiration"],
  ["../app/_components/authenticated-action-form", "AuthenticatedActionForm"],
  ["../app/(app)/brand-kit/_components/template-gallery", "TemplateGallery"],
  ["../app/(app)/brand-kit/_components/brand-profile-default-button", "BrandProfileDefaultButton"],
  ["../app/(app)/brand-kit/_components/template-form", "TemplateForm"],
] as const) mock.module(file, () => ({ [name]: () => null }));
mock.module("../app/(app)/projects/actions", () => ({
  applyProjectBrandProfileFormAction() {}, queueTranscriptionFormAction() {}, regenerateClipsFormAction() {},
}));

let BrandKitPage: typeof import("../app/(app)/brand-kit/page").default;
let NewStylePage: typeof import("../app/(app)/brand-kit/styles/new/page").default;
let ProjectPage: typeof import("../app/(app)/projects/[projectId]/page").default;
let LockedButton: typeof import("../app/(app)/_components/upgrade").LockedButton;
let PlanLimitNotice: typeof import("../app/(app)/_components/plan-limit-notice").PlanLimitNotice;
beforeAll(async () => {
  ({ default: BrandKitPage } = await import("../app/(app)/brand-kit/page"));
  ({ default: NewStylePage } = await import("../app/(app)/brand-kit/styles/new/page"));
  ({ default: ProjectPage } = await import("../app/(app)/projects/[projectId]/page"));
  ({ LockedButton } = await import("../app/(app)/_components/upgrade"));
  ({ PlanLimitNotice } = await import("../app/(app)/_components/plan-limit-notice"));
});

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, any>>(child)
    ? [child, ...elements(child.props.children)] : []);
}

for (const [count, expectedTier] of [[0, "creator"], [3, "pro"], [10, "business"], [30, null]] as const) {
  test(`both style pages account for ${count} retained styles on Free`, async () => {
    styleCount = count;
    const library = elements(await BrandKitPage());
    const newStyle = elements(await NewStylePage());
    const libraryPrompt = library.find((node) => node.type === LockedButton && node.props.children === "New style")?.props.prompt ?? null;
    const notice = newStyle.find((node) => node.type === PlanLimitNotice)!;
    expect(libraryPrompt?.tier ?? null).toBe(expectedTier);
    expect(notice.props.upgrade?.tier ?? null).toBe(expectedTier);
    if (expectedTier) {
      expect(() => requirePlanFeature(expectedTier, "brand.customTemplates")).not.toThrow();
      expect(() => requireWithinPlanLimit(expectedTier, "brandTemplates", count)).not.toThrow();
    } else {
      expect(notice.props.message).toContain("Delete a style");
      expect(library.find((node) => node.type === PlanLimitNotice && node.props.message.includes("Delete a style"))).toBeDefined();
    }
  });
}

for (const scenario of [
  { spent: 1000, current: 0, expectedTier: "business" },
  { spent: 0, current: 1800, expectedTier: "creator" },
  { spent: 230, current: 291, expectedTier: "creator" },
  { spent: 1739, current: 1800, expectedTier: "business" },
] as const) {
  test(`transcription offers ${scenario.expectedTier} with ${scenario.spent} credits in the settlement period and ${scenario.current} in the current summary`, async () => {
    currentCredits = scenario.current;
    projectCredits = { periodStart: new Date("2026-09-01T00:00:00Z"), spentCredits: scenario.spent, state: "reserved" };
    sourceSeconds = 61 * 60;
    const page = elements(await ProjectPage({ params: Promise.resolve({ projectId: "project" }), searchParams: Promise.resolve({ tab: "clips" }) }));
    const notice = page.find((node) => node.type === PlanLimitNotice)!;
    expect(notice.props.upgrade?.tier).toBe(scenario.expectedTier);
  });
}

test("unknown duration or missing ledger facts cannot promise a source-specific purchase", async () => {
  for (const [seconds, credits] of [[null, { periodStart: new Date(), spentCredits: 0, state: "reserved" }], [0, { periodStart: new Date(), spentCredits: 0, state: "reserved" }], [3660, null]] as const) {
    sourceSeconds = seconds;
    projectCredits = credits;
    const page = elements(await ProjectPage({ params: Promise.resolve({ projectId: "project" }), searchParams: Promise.resolve({ tab: "clips" }) }));
    expect(page.find((node) => node.type === PlanLimitNotice)!.props.upgrade).toBeNull();
  }
});

// Settlement returns early for a settled or refunded Project, so its retry needs
// neither the length nor the credits, and the page must not block or sell them.
for (const [state, blocked] of [["reserved", true], ["released", true], ["settled", false], ["refunded", false]] as const) {
  test(`a ${state} Project ${blocked ? "keeps" : "drops"} the length block and upgrade offer`, async () => {
    currentCredits = 0;
    projectCredits = { periodStart: new Date("2026-10-01T00:00:00Z"), spentCredits: 0, state };
    sourceSeconds = 61 * 60;
    const page = elements(await ProjectPage({ params: Promise.resolve({ projectId: "project" }), searchParams: Promise.resolve({ tab: "clips" }) }));
    const notice = page.find((node) => node.type === PlanLimitNotice)!;
    const start = page.find((node) => node.props.pendingLabel === "Starting…")!;
    expect(notice.props.message === null).toBe(!blocked);
    expect(notice.props.upgrade?.tier ?? null).toBe(blocked ? "creator" : null);
    expect(start.props.disabled).toBe(blocked);
  });
}
