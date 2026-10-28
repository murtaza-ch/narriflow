import { describe, expect, test } from "bun:test";

import { type ClipsClient, createClipsClient } from "@narriflow/api-client/clips";
import type { BrandMutations } from "@narriflow/api-client/brand";
import { hasFeature, planFeatureRequirement, type PricingTier } from "@narriflow/validators";

import {
  buildApplyMotionSelectedInput,
  buildApplyProjectBrandProfileSelectedInput,
  buildApplySceneTemplateSelectedInput,
  buildApplyStyleSelectedInput,
  buildCampaignEditorRetryRequest,
  campaignActionAccess,
  deriveCampaignActionPlan,
  deriveCampaignCommandState,
  deriveCampaignMotionDialogState,
  serializeCampaignEditorActionPreflightRequest,
  submitCampaignEditorAction,
} from "./campaign-command-state";

/**
 * The branding rule the page derives from the Workspace's plan: a personal
 * Workspace needs the feature; a shared one also needs members, which only
 * Business has among the paid plans.
 */
function brandPlanRequirement(
  scope: { pricingTier: PricingTier; isPersonalWorkspace: boolean },
  feature: "brand.profiles",
) {
  if (scope.isPersonalWorkspace) return planFeatureRequirement(scope.pricingTier, feature);
  if (hasFeature(scope.pricingTier, feature) && hasFeature(scope.pricingTier, "workspace.members")) return null;
  return { requiredTier: "business" as const };
}

const ALL_ENABLED = {
  exports: "enabled",
  creative: "enabled",
  motion: "enabled",
} as const;

function clip(id: string, ready: boolean, revision: number) {
  return {
    id,
    editorRevision: revision,
    brollUrl: null,
    brollPlacements: [],
    renderVariants: ready
      ? [
          {
            aspectRatio: "9:16" as const,
            status: "completed" as const,
            hasAsset: true,
            resolution: "1080p" as const,
          },
        ]
      : [],
  };
}

describe("campaign command state", () => {
  test("prepares only missing immutable exports for a mixed selection", () => {
    const state = deriveCampaignCommandState({
      clips: [clip("ready", true, 4), clip("missing", false, 7)],
      selectedIds: new Set(["ready", "missing"]),
      defaultAspectRatio: "9:16",
      actionAvailability: ALL_ENABLED,
    });

    expect(state.primary).toBe("prepare_exports");
    expect(state.readyItems).toEqual([
      { clipId: "ready", expectedEditorRevision: 4 },
    ]);
    expect(state.attentionItems).toEqual([
      {
        clipId: "missing",
        expectedEditorRevision: 7,
        code: "export_required",
      },
    ]);
  });

  test("has no mutation for an empty selection", () => {
    const empty = deriveCampaignCommandState({
      clips: [clip("ready", true, 1)],
      selectedIds: new Set(),
      defaultAspectRatio: "9:16",
      actionAvailability: ALL_ENABLED,
    });
    expect(empty).toMatchObject({ selectedCount: 0, primary: null });

  });

  test("derives command access from plan entitlements", () => {
    expect(campaignActionAccess(false)).toBe("plan_locked");
    expect(campaignActionAccess(true)).toBe("enabled");
  });

  test("keeps plan-locked commands visible but not executable", () => {
    const state = deriveCampaignCommandState({
      clips: [clip("ready", true, 1)],
      selectedIds: new Set(["ready"]),
      defaultAspectRatio: "9:16",
      actionAvailability: {
        exports: "plan_locked",
        creative: "plan_locked",
        motion: "plan_locked",
      },
    });

    expect(state.availableActions).toEqual(["render_selected"]);
    expect(state.lockedActions).toEqual([
      "export_bundle",
      "apply_brand_profile",
      "apply_style",
      "apply_scene_template",
      "apply_motion",
    ]);
    expect(state.primary).toBe("render_selected");
  });

  test("locks motion alone when only the motion entitlement is missing", () => {
    const state = deriveCampaignCommandState({
      clips: [clip("ready", true, 1)],
      selectedIds: new Set(["ready"]),
      defaultAspectRatio: "9:16",
      actionAvailability: { ...ALL_ENABLED, motion: "plan_locked" },
    });
    expect(state.availableActions).not.toContain("apply_motion");
    expect(state.lockedActions).toEqual(["apply_motion"]);
  });

  test("brand application offers Business in a shared Creator workspace while motion keeps its own tier", () => {
    const plan = deriveCampaignActionPlan({
      pricingTier: "creator",
      brandRequirement: brandPlanRequirement(
        { pricingTier: "creator", isPersonalWorkspace: false },
        "brand.profiles",
      ),
    });
    expect(plan.availability).toEqual({
      exports: "plan_locked",
      creative: "plan_locked",
      motion: "plan_locked",
    });
    expect(plan.upgradePrompts.creative?.tier).toBe("business");
    expect(plan.upgradePrompts.motion?.tier).toBe("pro");
    expect(plan.upgradePrompts.exports?.tier).toBe("pro");
  });

  test("a Business brand requirement does not lock motion that the plan covers", () => {
    const plan = deriveCampaignActionPlan({
      pricingTier: "pro",
      brandRequirement: brandPlanRequirement(
        { pricingTier: "pro", isPersonalWorkspace: false },
        "brand.profiles",
      ),
    });
    expect(plan.availability).toMatchObject({
      exports: "enabled",
      creative: "plan_locked",
      motion: "enabled",
    });
    expect(plan.upgradePrompts.creative?.tier).toBe("business");
    expect(plan.upgradePrompts.motion).toBeNull();

    const state = deriveCampaignCommandState({
      clips: [clip("ready", true, 1)],
      selectedIds: new Set(["ready"]),
      defaultAspectRatio: "9:16",
      actionAvailability: plan.availability,
    });
    expect(state.availableActions).toContain("apply_motion");
    expect(state.lockedActions).toEqual([
      "apply_brand_profile",
      "apply_style",
      "apply_scene_template",
    ]);
  });

  test("brand commands run on a personal or qualifying workspace and offer nothing else", () => {
    const business = deriveCampaignActionPlan({
      pricingTier: "business",
      brandRequirement: brandPlanRequirement(
        { pricingTier: "business", isPersonalWorkspace: false },
        "brand.profiles",
      ),
    });
    expect(business.availability.creative).toBe("enabled");
    expect(business.upgradePrompts.creative).toBeNull();

    const personalCreator = deriveCampaignActionPlan({
      pricingTier: "creator",
      brandRequirement: brandPlanRequirement(
        { pricingTier: "creator", isPersonalWorkspace: true },
        "brand.profiles",
      ),
    });
    expect(personalCreator.upgradePrompts.creative?.tier).toBe("pro");
  });

  test("keeps rerender available after every selected export is ready", () => {
    const state = deriveCampaignCommandState({
      clips: [clip("ready", true, 1)],
      selectedIds: new Set(["ready"]),
      defaultAspectRatio: "9:16",
      actionAvailability: ALL_ENABLED,
    });

    expect(state.primary).toBe("export_bundle");
    expect(state.availableActions).toContain("render_selected");
  });

  test("builds every creative action from the same revision fences", () => {
    const selectedItems = [
      { clipId: "a", expectedEditorRevision: 4, hasManualBroll: true },
      { clipId: "b", expectedEditorRevision: 7, hasManualBroll: false },
    ];
    const clips = [
      { clipId: "a", expectedEditorRevision: 4 },
      { clipId: "b", expectedEditorRevision: 7 },
    ];
    const templateId = "10000000-0000-4000-8000-000000000001";
    const fingerprint = "a".repeat(64);

    expect(
      buildApplyProjectBrandProfileSelectedInput(
        fingerprint,
        null,
        selectedItems,
      ),
    ).toEqual({ profileFingerprint: fingerprint, styleFingerprint: null, clips });
    expect(
      buildApplyStyleSelectedInput(templateId, fingerprint, selectedItems),
    ).toEqual({ templateId, templateFingerprint: fingerprint, clips });
    expect(
      buildApplySceneTemplateSelectedInput(fingerprint, "end", selectedItems),
    ).toEqual({ templateFingerprint: fingerprint, placement: "end", clips });
    expect(
      buildApplyMotionSelectedInput(
        {
          scope: "manual_broll",
          motion: { entrance: "ken-burns-in", exit: "fade" },
        },
        selectedItems,
      ),
    ).toEqual({
      change: {
        scope: "manual_broll",
        motion: { entrance: "ken-burns-in", exit: "fade" },
      },
      clips,
    });
  });

  test("previews exact mixed manual B-roll eligibility", () => {
    const withBroll = { ...clip("eligible", true, 3), brollUrl: "https://media.test/broll.mp4" };
    const state = deriveCampaignCommandState({
      clips: [withBroll, clip("missing", true, 5)],
      selectedIds: new Set(["eligible", "missing"]),
      defaultAspectRatio: "9:16",
      actionAvailability: ALL_ENABLED,
    });
    expect(deriveCampaignMotionDialogState(state, "manual_broll")).toEqual({
      eligibleCount: 1,
      attentionCount: 1,
      canSubmit: true,
    });
    expect(
      deriveCampaignMotionDialogState(
        deriveCampaignCommandState({
          clips: [clip("missing", true, 5)],
          selectedIds: new Set(["missing"]),
          defaultAspectRatio: "9:16",
          actionAvailability: ALL_ENABLED,
        }),
        "manual_broll",
      ),
    ).toMatchObject({ eligibleCount: 0, canSubmit: false });
  });

  test("retries only failed and refreshed stale items", () => {
    const fingerprint = "b".repeat(64);
    expect(
      buildCampaignEditorRetryRequest({
        operation: {
          action: "apply_style",
          items: [
            { requestedClipId: "success", status: "succeeded" },
            { requestedClipId: "same", status: "unchanged" },
            { requestedClipId: "blocked", status: "ineligible" },
            {
              requestedClipId: "stale",
              expectedEditorRevision: 5,
              status: "stale",
            },
            { requestedClipId: "failed", status: "failed" },
          ],
        },
        intent: {
          action: "apply_style",
          templateId: "10000000-0000-4000-8000-000000000001",
          templateFingerprint: fingerprint,
        },
        selectedItems: [
          { clipId: "success", expectedEditorRevision: 4, hasManualBroll: false },
          { clipId: "same", expectedEditorRevision: 4, hasManualBroll: false },
          { clipId: "blocked", expectedEditorRevision: 4, hasManualBroll: false },
          { clipId: "stale", expectedEditorRevision: 8, hasManualBroll: false },
          { clipId: "failed", expectedEditorRevision: 9, hasManualBroll: false },
        ],
      }),
    ).toEqual({
      action: "apply_style",
      input: {
        templateId: "10000000-0000-4000-8000-000000000001",
        templateFingerprint: fingerprint,
        clips: [
          { clipId: "stale", expectedEditorRevision: 8 },
          { clipId: "failed", expectedEditorRevision: 9 },
        ],
      },
    });
  });

  test("keeps equivalent preflight requests stable", () => {
    const request = {
      action: "apply_style",
      input: {
        templateId: "10000000-0000-4000-8000-000000000001",
        templateFingerprint: "c".repeat(64),
        clips: [{ clipId: "a", expectedEditorRevision: 2 }],
      },
    };
    expect(serializeCampaignEditorActionPreflightRequest(request)).toBe(
      serializeCampaignEditorActionPreflightRequest(structuredClone(request)),
    );
  });
});

describe("submitCampaignEditorAction", () => {
  const PROJECT = "40000000-0000-4000-8000-000000000001";
  const PROFILE = "40000000-0000-4000-8000-000000000002";
  const TEMPLATE = "40000000-0000-4000-8000-000000000003";
  const RETRY_OF = "50000000-0000-4000-8000-000000000001";
  const FINGERPRINT = "a".repeat(64);
  const clips = [{ clipId: "40000000-0000-4000-8000-000000000004", expectedEditorRevision: 3 }];

  function harness() {
    const calls: Array<{ url: string; key: string | null; retryOf: string | null }> = [];
    const clipsClient: ClipsClient = createClipsClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          key: headers.get("idempotency-key"),
          retryOf: headers.get("campaign-retry-of"),
        });
        return Response.json({ operationId: "op-1" });
      }) as typeof fetch,
    });
    const brand = {
      applySceneTemplate: async (
        target: { projectId: string; profileId: string; templateId: string },
        _input: unknown,
        options: { idempotencyKey: string; retryOfId?: string },
      ) => {
        calls.push({
          url: `scene:${target.profileId}:${target.templateId}`,
          key: options.idempotencyKey,
          retryOf: options.retryOfId ?? null,
        });
        return { operationId: "op-scene" };
      },
    } as unknown as BrandMutations;
    return { calls, api: { clips: clipsClient, brand } };
  }

  test("every editor action carries the intent's key and the operation it retries", async () => {
    const { api, calls } = harness();
    const options = { idempotencyKey: "intent-1", retryOfId: RETRY_OF };
    await submitCampaignEditorAction(api, PROJECT, {
      action: "apply_brand_profile",
      input: { profileFingerprint: FINGERPRINT, styleFingerprint: null, clips },
    }, options);
    await submitCampaignEditorAction(api, PROJECT, {
      action: "apply_style",
      input: { templateId: TEMPLATE, templateFingerprint: FINGERPRINT, clips },
    }, options);
    await submitCampaignEditorAction(api, PROJECT, {
      action: "apply_motion",
      input: {
        change: { scope: "clip_transition", transition: { type: "fade", durationSec: 0.4 } },
        clips,
      },
    }, options);
    await submitCampaignEditorAction(api, PROJECT, {
      action: "apply_scene_template",
      profileId: PROFILE,
      templateId: TEMPLATE,
      input: { templateFingerprint: FINGERPRINT, placement: "start", clips },
    }, options);

    expect(calls.map((call) => call.url.replace("https://api.example.test", ""))).toEqual([
      `/api/projects/${PROJECT}/campaign-operations/apply-brand-profile`,
      `/api/projects/${PROJECT}/campaign-operations/apply-style`,
      `/api/projects/${PROJECT}/campaign-operations/apply-motion`,
      `scene:${PROFILE}:${TEMPLATE}`,
    ]);
    for (const call of calls) {
      expect(call.key).toBe("intent-1");
      expect(call.retryOf).toBe(RETRY_OF);
    }
  });

  test("a first attempt names no operation to retry", async () => {
    const { api, calls } = harness();
    await submitCampaignEditorAction(api, PROJECT, {
      action: "apply_style",
      input: { templateId: TEMPLATE, templateFingerprint: FINGERPRINT, clips },
    }, { idempotencyKey: "intent-2" });
    expect(calls[0]).toMatchObject({ key: "intent-2", retryOf: null });
  });
});
