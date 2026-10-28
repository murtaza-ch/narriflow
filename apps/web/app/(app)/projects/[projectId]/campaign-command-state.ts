import {
  hasFeature,
  planFeatureRequirement,
  planUpgradeHighlight,
  PRICING_TIER_ORDER,
  type ApplyMotionSelectedInput,
  type ApplyProjectBrandProfileSelectedInput,
  type ApplySceneTemplateInput,
  type ApplyStyleSelectedInput,
  type ClipAspectRatio,
  type ClipSnapshot,
  type PricingTier,
} from "@narriflow/validators";
import { type ClipsClient, clipCommands } from "@narriflow/api-client/clips";
import type { BrandMutations } from "@narriflow/api-client/brand";
import type { UpgradePrompt } from "@/app/(app)/_components/upgrade";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";

export type CampaignPrimaryAction =
  | "prepare_exports"
  | "export_bundle"
  | "render_selected";

export type CampaignAvailableAction =
  | "render_selected"
  | "export_bundle"
  | "apply_brand_profile"
  | "apply_style"
  | "apply_scene_template"
  | "apply_motion";

/**
 * Plan-locked campaign commands stay visible and open the upgrade dialog.
 */
export type CampaignActionAccess = "enabled" | "plan_locked";

export type CampaignActionAvailability = Readonly<{
  exports: CampaignActionAccess;
  creative: CampaignActionAccess;
  motion: CampaignActionAccess;
}>;

export function campaignActionAccess(
  entitled: boolean,
): CampaignActionAccess {
  return entitled ? "enabled" : "plan_locked";
}

/**
 * Availability and upgrade prompt for each campaign command group. Creative
 * commands (brand profile, style, scene template) also pass the shared-
 * Workspace branding policy the service enforces, so `brandRequirement`
 * (`brandPlanRequirement(scope, "brand.profiles")`) joins the campaign plan
 * requirement there. Motion and export bundles keep their own requirements.
 * A prompt offers the highest tier any unmet requirement needs, and none when
 * a requirement has no qualifying plan.
 */
export function deriveCampaignActionPlan(input: {
  pricingTier: string;
  brandRequirement: { requiredTier: PricingTier | null } | null;
}): {
  availability: CampaignActionAvailability;
  upgradePrompts: Record<keyof CampaignActionAvailability, UpgradePrompt | null>;
} {
  const { pricingTier, brandRequirement } = input;
  const campaignOperations = hasFeature(pricingTier, "campaign.operations");
  const creativeHeadline = "Upgrade to apply changes across clips";
  const campaignRequirement = planFeatureRequirement(
    pricingTier,
    "campaign.operations",
  );
  const unmet = [
    campaignRequirement && {
      gate: "campaign.operations" as const,
      tier: campaignRequirement.requiredTier,
    },
    brandRequirement && {
      gate: "brand.profiles" as const,
      tier: brandRequirement.requiredTier,
    },
  ].filter((requirement) => requirement !== null);
  let creativePrompt: UpgradePrompt | null = null;
  if (unmet.length > 0 && unmet.every((requirement) => requirement.tier)) {
    const highest = unmet.reduce((best, next) =>
      PRICING_TIER_ORDER.indexOf(next.tier as PricingTier) >
      PRICING_TIER_ORDER.indexOf(best.tier as PricingTier)
        ? next
        : best,
    );
    const tier = highest.tier as PricingTier;
    creativePrompt = {
      tier,
      headline: creativeHeadline,
      highlight: planUpgradeHighlight(tier, highest.gate),
    };
  }
  return {
    availability: {
      exports: campaignActionAccess(
        campaignOperations && hasFeature(pricingTier, "export.bundles"),
      ),
      creative: campaignActionAccess(
        campaignOperations && brandRequirement === null,
      ),
      motion: campaignActionAccess(
        campaignOperations && hasFeature(pricingTier, "editor.motion"),
      ),
    },
    upgradePrompts: {
      exports: featureUpgradePrompt(
        pricingTier,
        ["campaign.operations", "export.bundles"],
        "Upgrade to build export bundles",
      ),
      creative: creativePrompt,
      motion: featureUpgradePrompt(
        pricingTier,
        ["campaign.operations", "editor.motion"],
        "Upgrade to apply motion across clips",
      ),
    },
  };
}

type CampaignClip = Pick<
  ClipSnapshot,
  "id" | "editorRevision" | "brollUrl"
> & {
  renderVariants: Array<
    Pick<
      ClipSnapshot["renderVariants"][number],
      "aspectRatio" | "status" | "hasAsset" | "resolution"
    >
  >;
};

export interface CampaignCommandState {
  selectedCount: number;
  selectedClipIds: string[];
  selectedItems: Array<{
    clipId: string;
    expectedEditorRevision: number;
    hasManualBroll: boolean;
  }>;
  primary: CampaignPrimaryAction | null;
  /** Commands that run. */
  availableActions: CampaignAvailableAction[];
  /** Commands that exist but need a higher plan: shown with a gem, they open the upgrade dialog. */
  lockedActions: CampaignAvailableAction[];
  readyItems: Array<{ clipId: string; expectedEditorRevision: number }>;
  attentionItems: Array<{
    clipId: string;
    expectedEditorRevision: number;
    code: "export_required";
  }>;
}

export type CampaignEditorRetryIntent =
  | {
      action: "apply_brand_profile";
      profileFingerprint: string;
      styleFingerprint: string | null;
    }
  | {
      action: "apply_style";
      templateId: string;
      templateFingerprint: string;
    }
  | {
      action: "apply_scene_template";
      profileId: string;
      templateId: string;
      templateFingerprint: string;
      placement: ApplySceneTemplateInput["placement"];
    }
  | {
      action: "apply_motion";
      change: ApplyMotionSelectedInput["change"];
    };

export type CampaignEditorRetryRequest =
  | { action: "apply_brand_profile"; input: ApplyProjectBrandProfileSelectedInput }
  | { action: "apply_style"; input: ApplyStyleSelectedInput }
  | {
      action: "apply_scene_template";
      profileId: string;
      templateId: string;
      input: ApplySceneTemplateInput;
    }
  | { action: "apply_motion"; input: ApplyMotionSelectedInput };

/** What the API answers once it accepted a campaign command; the operation list holds the item rows. */
export type CampaignOperationAcceptance = {
  operationId?: string;
  status?: string;
  requestedCount?: number;
  counts?: {
    succeeded: number;
    unchanged: number;
    stale: number;
    ineligible: number;
    failed: number;
  };
};

/**
 * Sends one campaign editor command. `idempotencyKey` is minted once per user
 * intent and reused by every retry of it; `retryOfId` names the operation a
 * retry continues, so the server keeps one identity for both.
 */
export function submitCampaignEditorAction(
  api: { clips: ClipsClient; brand: BrandMutations },
  projectId: string,
  request: CampaignEditorRetryRequest,
  options: { idempotencyKey: string; retryOfId?: string },
): Promise<CampaignOperationAcceptance> {
  const { idempotencyKey, retryOfId } = options;
  switch (request.action) {
    case "apply_brand_profile":
      return clipCommands.applyBrandProfile(api.clips, projectId, request.input, idempotencyKey, retryOfId);
    case "apply_style":
      return clipCommands.applyStyle(api.clips, projectId, request.input, idempotencyKey, retryOfId);
    case "apply_motion":
      return clipCommands.applyMotion(api.clips, projectId, request.input, idempotencyKey, retryOfId);
    case "apply_scene_template":
      return api.brand.applySceneTemplate(
        { projectId, profileId: request.profileId, templateId: request.templateId },
        request.input,
        { idempotencyKey, retryOfId },
      );
  }
}

function revisionFences(selectedItems: CampaignCommandState["selectedItems"]) {
  return selectedItems.map(({ clipId, expectedEditorRevision }) => ({
    clipId,
    expectedEditorRevision,
  }));
}

export function buildApplyProjectBrandProfileSelectedInput(
  profileFingerprint: string,
  styleFingerprint: string | null,
  selectedItems: CampaignCommandState["selectedItems"],
): ApplyProjectBrandProfileSelectedInput {
  return {
    profileFingerprint,
    styleFingerprint,
    clips: revisionFences(selectedItems),
  };
}

export function buildApplyStyleSelectedInput(
  templateId: string,
  templateFingerprint: string,
  selectedItems: CampaignCommandState["selectedItems"],
): ApplyStyleSelectedInput {
  return {
    templateId,
    templateFingerprint,
    clips: revisionFences(selectedItems),
  };
}

export function buildApplySceneTemplateSelectedInput(
  templateFingerprint: string,
  placement: ApplySceneTemplateInput["placement"],
  selectedItems: CampaignCommandState["selectedItems"],
): ApplySceneTemplateInput {
  return {
    templateFingerprint,
    placement,
    clips: revisionFences(selectedItems),
  };
}

export function buildApplyMotionSelectedInput(
  change: ApplyMotionSelectedInput["change"],
  selectedItems: CampaignCommandState["selectedItems"],
): ApplyMotionSelectedInput {
  return { change, clips: revisionFences(selectedItems) };
}

export function serializeCampaignEditorActionPreflightRequest(
  request: unknown | null,
): string | null {
  return request === null ? null : JSON.stringify(request);
}

export function campaignMotionMissingTargets(
  state: CampaignCommandState,
  scope: ApplyMotionSelectedInput["change"]["scope"],
) {
  return scope === "manual_broll"
    ? state.selectedItems.filter((item) => !item.hasManualBroll)
    : [];
}

export function deriveCampaignMotionDialogState(
  state: CampaignCommandState,
  scope: ApplyMotionSelectedInput["change"]["scope"],
) {
  const missingTargets = campaignMotionMissingTargets(state, scope);
  const eligibleCount = state.selectedItems.length - missingTargets.length;
  return {
    eligibleCount,
    attentionCount: missingTargets.length,
    canSubmit: eligibleCount > 0,
  };
}

export function buildCampaignEditorRetryRequest(input: {
  operation: {
    action: string;
    items: ReadonlyArray<{
      requestedClipId: string;
      expectedEditorRevision?: number | null;
      status: string;
    }>;
  };
  intent: CampaignEditorRetryIntent | null;
  selectedItems: CampaignCommandState["selectedItems"];
}): CampaignEditorRetryRequest | null {
  if (!input.intent || input.operation.action !== input.intent.action) return null;
  const outcomes = new Map(
    input.operation.items.map((item) => [item.requestedClipId, item]),
  );
  const retryItems = input.selectedItems.filter((item) => {
    const outcome = outcomes.get(item.clipId);
    if (outcome?.status === "failed") return true;
    return (
      outcome?.status === "stale" &&
      outcome.expectedEditorRevision != null &&
      item.expectedEditorRevision !== outcome.expectedEditorRevision
    );
  });
  if (retryItems.length === 0) return null;

  if (input.intent.action === "apply_brand_profile") {
    return {
      action: input.intent.action,
      input: buildApplyProjectBrandProfileSelectedInput(
        input.intent.profileFingerprint,
        input.intent.styleFingerprint,
        retryItems,
      ),
    };
  }
  if (input.intent.action === "apply_style") {
    return {
      action: input.intent.action,
      input: buildApplyStyleSelectedInput(
        input.intent.templateId,
        input.intent.templateFingerprint,
        retryItems,
      ),
    };
  }
  if (input.intent.action === "apply_scene_template") {
    return {
      action: input.intent.action,
      profileId: input.intent.profileId,
      templateId: input.intent.templateId,
      input: buildApplySceneTemplateSelectedInput(
        input.intent.templateFingerprint,
        input.intent.placement,
        retryItems,
      ),
    };
  }
  return {
    action: input.intent.action,
    input: buildApplyMotionSelectedInput(input.intent.change, retryItems),
  };
}

export function deriveCampaignCommandState(input: {
  clips: CampaignClip[];
  selectedIds: ReadonlySet<string>;
  defaultAspectRatio: ClipAspectRatio;
  actionAvailability: CampaignActionAvailability;
}): CampaignCommandState {
  const selected = input.clips.filter((clip) => input.selectedIds.has(clip.id));
  const readyItems: CampaignCommandState["readyItems"] = [];
  const attentionItems: CampaignCommandState["attentionItems"] = [];
  for (const clip of selected) {
    const ready = clip.renderVariants.some(
      (variant) =>
        variant.aspectRatio === input.defaultAspectRatio &&
        variant.status === "completed" &&
        variant.hasAsset,
    );
    const item = { clipId: clip.id, expectedEditorRevision: clip.editorRevision };
    if (ready) readyItems.push(item);
    else attentionItems.push({ ...item, code: "export_required" });
  }
  const { exports, creative, motion } = input.actionAvailability;
  const availableActions: CampaignAvailableAction[] = [
    "render_selected",
    ...(exports === "enabled" ? (["export_bundle"] as const) : []),
    ...(creative === "enabled"
      ? ([
          "apply_brand_profile",
          "apply_style",
          "apply_scene_template",
        ] as const)
      : []),
    ...(motion === "enabled" ? (["apply_motion"] as const) : []),
  ];
  const lockedActions: CampaignAvailableAction[] = [
    ...(exports === "plan_locked" ? (["export_bundle"] as const) : []),
    ...(creative === "plan_locked"
      ? ([
          "apply_brand_profile",
          "apply_style",
          "apply_scene_template",
        ] as const)
      : []),
    ...(motion === "plan_locked" ? (["apply_motion"] as const) : []),
  ];
  return {
    selectedCount: selected.length,
    selectedClipIds: selected.map((clip) => clip.id),
    selectedItems: selected.map((clip) => ({
      clipId: clip.id,
      expectedEditorRevision: clip.editorRevision,
      hasManualBroll: Boolean(clip.brollUrl),
    })),
    primary:
      selected.length === 0
        ? null
        : attentionItems.length > 0
          ? "prepare_exports"
          : availableActions.includes("export_bundle")
            ? "export_bundle"
            : "render_selected",
    availableActions,
    lockedActions,
    readyItems,
    attentionItems,
  };
}
