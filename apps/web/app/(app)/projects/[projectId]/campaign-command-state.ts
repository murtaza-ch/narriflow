import type {
  ApplyMotionSelectedInput,
  ApplyProjectBrandProfileSelectedInput,
  ApplySceneTemplateInput,
  ApplyStyleSelectedInput,
  ClipAspectRatio,
  ClipSnapshot,
} from "@narriflow/validators";

export type CampaignPrimaryAction = "prepare_exports" | "export_bundle";

export type CampaignAvailableAction =
  | "export_bundle"
  | "apply_brand_profile"
  | "apply_style"
  | "apply_scene_template"
  | "apply_motion";

export type CampaignActionAvailability = Readonly<{
  exports: boolean;
  creative: boolean;
  motion: boolean;
}>;

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
  availableActions: CampaignAvailableAction[];
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
  const availableActions: CampaignAvailableAction[] = [
    ...(input.actionAvailability.exports ? (["export_bundle"] as const) : []),
    ...(input.actionAvailability.creative
      ? ([
          "apply_brand_profile",
          "apply_style",
          "apply_scene_template",
        ] as const)
      : []),
    ...(input.actionAvailability.creative && input.actionAvailability.motion
      ? (["apply_motion"] as const)
      : []),
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
            : null,
    availableActions,
    readyItems,
    attentionItems,
  };
}
