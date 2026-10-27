import { describe, expect, test } from "bun:test";

import { brandPlanRequirement } from "@narriflow/services";

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
} from "./campaign-command-state";

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
