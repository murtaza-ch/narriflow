import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  clipAspectRatioFromDb,
  applyProjectBrandProfileSelectedSchema,
  applyStyleSelectedSchema,
  applyEditorAction,
  applyMotionSelectedSchema,
  applySceneTemplateSchema,
  brandProfileSnapshotSchema,
  brandTemplateSnapshotSchema,
  buildEditedTimeMap,
  CAMPAIGN_OPERATION_ITEM_CONCURRENCY,
  createExportBundleSchema,
  exportBundleManifestSchema,
  previewCampaignEditorActionSchema,
  sceneTemplateDefinitionSchema,
  type ClipAspectRatio,
  type ClipRenderResolution,
  type CreateExportBundleInput,
  type ApplyMotionSelectedInput,
  type ApplyProjectBrandProfileSelectedInput,
  type ApplyStyleSelectedInput,
  type BrandTemplateSnapshot,
  type EditorDocument,
  type PricingTier,
  type ExportBundleManifest,
  type WorkspaceAccessRole,
  type WorkspaceAccessStatus,
  workspaceAllowsCapability,
} from "@narriflow/validators";
import {
  assertBrandApplicationAllowed,
  BrandAccessError,
  type BrandActorScope,
} from "./brand-ownership";
import { brandTemplateService } from "./brand-template.service";
import {
  clipEditorDocumentPersistence,
  ClipEditorDocumentPersistenceError,
  ClipEditorRevisionConflictError,
} from "./clip-editor-document-persistence";
import { hasFeature } from "./plan-features";
import {
  assertCampaignActionWriteEnabled,
  assertProgramWriteEnabled,
  campaignActionWriteEnabled,
} from "./program-rollout";
import { presignDownloadUrl } from "./r2-storage";
import { sceneTemplateService, SceneTemplateError } from "./scene-template.service";
import { getWorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { analyticsService } from "./analytics.service";

export class CampaignOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CampaignOperationError";
  }
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertCampaignBrandApplicationAllowed(scope: CampaignBrandActorScope) {
  if (!hasFeature(scope.pricingTier as PricingTier, "campaign.operations")) {
    throw new CampaignOperationError(
      "campaign_operation_feature_unavailable",
      "Selection-scoped brand actions require Pro or Business",
    );
  }
  try {
    assertBrandApplicationAllowed(scope);
  } catch (error) {
    if (error instanceof BrandAccessError) {
      throw new CampaignOperationError(
        error.code === "brand_forbidden"
          ? "campaign_operation_forbidden"
          : "campaign_operation_feature_unavailable",
        error.message,
      );
    }
    throw error;
  }
}

export function exportBundleRetentionMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = env.EXPORT_BUNDLE_RETENTION_DAYS?.trim() || "7";
	if (!/^\d+$/.test(raw)) {
		throw new CampaignOperationError("export_bundle_retention_invalid", "Export bundle retention must be a whole number of days");
	}
	const days = Number(raw);
	if (!Number.isSafeInteger(days) || days < 1 || days > 30) {
		throw new CampaignOperationError("export_bundle_retention_invalid", "Export bundle retention must be between 1 and 30 days");
	}
	return days * 24 * 60 * 60_000;
}

function safeStem(value: string | null, index: number) {
  const stem = (value || `clip-${index + 1}`)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .toLowerCase();
  return stem || `clip-${index + 1}`;
}

export function allocateBundleFileNames(input: Array<{ clipId: string; title: string | null; variants: Array<{ id: string; aspectRatio: ClipAspectRatio }> }>) {
  const used = new Map<string, number>();
  return input.map((clip, index) => {
    const stem = safeStem(clip.title, index);
    const occurrence = (used.get(stem) ?? 0) + 1;
    used.set(stem, occurrence);
		const stableIndex = String(index + 1).padStart(3, "0");
		const uniqueStem = occurrence === 1 ? stem : `${stem}-${occurrence}`;
		const directory = `project/${stableIndex}-${uniqueStem}`;
    return {
      clipId: clip.clipId,
      files: clip.variants.map((variant) => ({
        variantId: variant.id,
				name: `${directory}/${variant.aspectRatio.replace(":", "x")}.mp4`,
      })),
    };
  });
}

type RenderResult = { workflowRunId: string; acceptedAt: string; initialSeq: number; clipCount: number; variantCount: number; resolution: ClipRenderResolution };
type CampaignOperationSnapshot = {
  id: string;
  status: string;
  requestedCount: number;
  succeededCount: number;
  unchangedCount: number;
  staleCount: number;
  ineligibleCount: number;
  failedCount: number;
};
type ApplySceneTemplateResult = ReturnType<typeof campaignOperationSnapshot> & { replayed: boolean };
type ApplyMotionSelectedResult = ReturnType<typeof campaignOperationSnapshot> & { replayed: boolean };
type ApplyCampaignStyleResult = ReturnType<typeof campaignOperationSnapshot> & { replayed: boolean };
type CampaignMotionActorScope = {
  actorUserId: string;
  workspaceId: string;
  workspaceOwnerUserId: string;
  projectId: string;
  pricingTier: PricingTier;
  role: WorkspaceAccessRole;
  status: WorkspaceAccessStatus;
  idempotencyKey: string;
  retryOfId?: string;
};
type CampaignBundleActorScope = {
  actorUserId: string;
  workspaceId: string;
  projectId: string;
  pricingTier: PricingTier;
  role: WorkspaceAccessRole;
  status: WorkspaceAccessStatus;
  idempotencyKey: string;
  retryOfId?: string;
};
type CampaignBundleAccessScope = Pick<
  CampaignBundleActorScope,
  "workspaceId" | "projectId" | "role" | "status"
>;
type CampaignBrandActorScope = BrandActorScope & {
  projectId: string;
  idempotencyKey: string;
  retryOfId?: string;
};

type SelectedEditorAction = "apply_brand_profile" | "apply_style";
type SelectedEditorItem = {
  clipId: string;
  expectedEditorRevision: number;
};

type CampaignMotionMutation =
  | { status: "unchanged"; document: EditorDocument }
  | { status: "ineligible"; code: "campaign_motion_target_missing" }
  | { status: "failed"; code: "campaign_motion_document_limit" }
  | { status: "changed"; document: EditorDocument };

function* boundedCampaignOperationItems<T>(items: T[]): Generator<T> {
  for (
    let offset = 0;
    offset < items.length;
    offset += CAMPAIGN_OPERATION_ITEM_CONCURRENCY
  ) {
    yield* items.slice(offset, offset + CAMPAIGN_OPERATION_ITEM_CONCURRENCY);
  }
}

function assertCampaignBundleAllowed(scope: CampaignBundleAccessScope) {
  if (
    !workspaceAllowsCapability(
      { role: scope.role, status: scope.status },
      "content.download",
    )
  ) {
    throw new CampaignOperationError(
      "campaign_operation_forbidden",
      "Export bundles cannot be created with this Workspace role",
    );
  }
}

async function resolveExportBundleSelection(
  scope: Pick<CampaignBundleAccessScope, "workspaceId" | "projectId">,
  input: CreateExportBundleInput,
) {
  const clips = await requirePrisma().clip.findMany({
    where: {
      projectId: scope.projectId,
      id: { in: input.clips.map((clip) => clip.clipId) },
      project: { workspaceId: scope.workspaceId },
    },
    select: {
      id: true,
      title: true,
      editorRevision: true,
      exports: {
        where: { status: "ready", resolution: input.resolution },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          variants: {
            where: {
              status: "completed",
              storageKey: { not: null },
              sizeBytes: { gt: 0 },
            },
          },
        },
      },
    },
  });
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  const resolved = input.clips.map((expected) => {
    const clip = clipsById.get(expected.clipId);
    const frozen = clip?.exports[0];
    const variants = frozen
      ? frozen.variants
          .filter((variant) =>
            input.aspectRatios.includes(
              clipAspectRatioFromDb[variant.aspectRatio],
            ),
          )
          .sort(
            (left, right) =>
              input.aspectRatios.indexOf(
                clipAspectRatioFromDb[left.aspectRatio],
              ) -
              input.aspectRatios.indexOf(
                clipAspectRatioFromDb[right.aspectRatio],
              ),
          )
      : [];
    const code = !clip
      ? "campaign_clip_not_found"
      : clip.editorRevision !== expected.expectedEditorRevision
        ? "campaign_clip_stale"
        : !frozen ||
            frozen.editorRevision !== expected.expectedEditorRevision ||
            variants.length === 0
          ? "export_variant_unavailable"
          : null;
    return {
      expected,
      clip: clip ?? null,
      frozen: frozen ?? null,
      variants,
      status: code === null ? ("eligible" as const) : code === "campaign_clip_stale" ? ("stale" as const) : ("ineligible" as const),
      code,
    };
  });
  return {
    clipsById,
    eligible: resolved.flatMap((item) =>
      item.status === "eligible" && item.clip && item.frozen
        ? [{ clip: item.clip, frozen: item.frozen, variants: item.variants }]
        : [],
    ),
    items: resolved.map((item) => ({
      clipId: item.expected.clipId,
      expectedEditorRevision: item.expected.expectedEditorRevision,
      currentEditorRevision: item.clip?.editorRevision ?? null,
      exportEditorRevision: item.frozen?.editorRevision ?? null,
      status: item.status,
      code: item.code,
      aspectRatios: item.variants.map(
        (variant) => clipAspectRatioFromDb[variant.aspectRatio],
      ),
      estimatedSizeBytes: item.variants.reduce(
        (total, variant) => total + Number(variant.sizeBytes),
        0,
      ),
    })),
  };
}

async function assertCampaignEditorRetry(input: {
  workspaceId: string;
  projectId: string;
  action: "apply_brand_profile" | "apply_style" | "apply_scene_template" | "apply_motion";
  retryOfId?: string;
  clips: SelectedEditorItem[];
}): Promise<void> {
  if (!input.retryOfId) return;
  const source = await requirePrisma().campaignOperation.findFirst({
    where: {
      id: input.retryOfId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      action: input.action,
    },
    include: {
      items: {
        select: {
          requestedClipId: true,
          expectedEditorRevision: true,
          status: true,
        },
      },
      retries: { select: { id: true }, take: 1 },
    },
  });
  if (!source) {
    throw new CampaignOperationError(
      "campaign_operation_not_found",
      "The source campaign operation was not found",
    );
  }
  if (source.retries.length > 0) {
    throw new CampaignOperationError(
      "campaign_operation_already_retried",
      "This campaign operation already has a retry",
    );
  }
  const sourceItems = new Map(
    source.items.map((item) => [item.requestedClipId, item]),
  );
  const invalid = input.clips.some((clip) => {
    const sourceItem = sourceItems.get(clip.clipId);
    if (!sourceItem) return true;
    if (sourceItem.status === "failed") return false;
    return !(
      sourceItem.status === "stale" &&
      sourceItem.expectedEditorRevision !== null &&
      clip.expectedEditorRevision !== sourceItem.expectedEditorRevision
    );
  });
  if (invalid) {
    throw new CampaignOperationError(
      "campaign_operation_no_retryable_items",
      "A retry may include only failed items or stale items with refreshed revisions",
    );
  }
}

async function throwIfCampaignRetryAlreadyExists(retryOfId?: string) {
  if (
    retryOfId &&
    (await requirePrisma().campaignOperation.count({ where: { retryOfId } })) > 0
  ) {
    throw new CampaignOperationError(
      "campaign_operation_already_retried",
      "This campaign operation already has a retry",
    );
  }
}

/**
 * Plans one selected motion mutation through the same Editor Document reducer
 * used by Studio. Keeping this pure makes equivalence, target eligibility,
 * and document-limit rejection independently testable; persistence remains a
 * single revision-guarded replace in the Campaign Operation service.
 */
export function applyCampaignMotionChange(
  document: EditorDocument,
  change: ApplyMotionSelectedInput["change"],
  createId: () => string = randomUUID,
): CampaignMotionMutation {
  if (change.scope === "clip_transition") {
    if (JSON.stringify(document.studioEdits.transition) === JSON.stringify(change.transition)) {
      return { status: "unchanged", document };
    }
    const next = applyEditorAction(document, {
      type: "setStudioEdits",
      studioEdits: { ...document.studioEdits, transition: change.transition },
    });
    return next === document
      ? { status: "failed", code: "campaign_motion_document_limit" }
      : { status: "changed", document: next };
  }

  if (!document.brollUrl) {
    return { status: "ineligible", code: "campaign_motion_target_missing" };
  }
  const brollMotions = document.mediaMotions.filter(
    (motion) => motion.target.kind === "broll",
  );
  const removeMotion = change.motion.entrance === "none" && change.motion.exit === "none";
  const totalDurationSec =
    buildEditedTimeMap(document.deletedRanges, {
      startSec: document.clipStartSec,
      endSec: document.clipEndSec,
    }).editedDurationSec +
    document.sceneBlocks.reduce((total, scene) => total + scene.durationSec, 0);
  const existing = brollMotions[0];
  const equivalent = removeMotion
    ? brollMotions.length === 0
    : brollMotions.length === 1 &&
      existing?.enabled === true &&
      Math.abs(existing.startSec) <= 0.001 &&
      Math.abs(existing.endSec - totalDurationSec) <= 0.001 &&
      existing.entrance === change.motion.entrance &&
      existing.exit === change.motion.exit &&
      existing.durationSec === change.motion.durationSec;
  if (equivalent) return { status: "unchanged", document };

  let next = document;
  for (const motion of brollMotions) {
    next = applyEditorAction(next, { type: "removeMediaMotion", id: motion.id });
  }
  if (removeMotion) {
    return next === document
      ? { status: "unchanged", document }
      : { status: "changed", document: next };
  }

  const inserted = applyEditorAction(next, {
    type: "insertMediaMotion",
    motion: {
      schemaVersion: 1,
      id: existing?.id ?? createId(),
      target: { kind: "broll" },
      startSec: 0,
      endSec: totalDurationSec,
      entrance: change.motion.entrance,
      exit: change.motion.exit,
      durationSec: change.motion.durationSec,
      enabled: true,
    },
  });
  return inserted === next
    ? { status: "failed", code: "campaign_motion_document_limit" }
    : { status: "changed", document: inserted };
}

const INHERITED_STUDIO_LOGO = {
  enabled: true,
  position: null,
  opacity: null,
  scalePct: null,
} as const;

/**
 * Applies the exact Brand Template reducer policy used by single-clip Studio:
 * template caption fields win, while the clip's hand-positioned caption X/Y
 * and font size remain local. Applying the Project Brand Profile additionally
 * clears per-clip logo presentation overrides so the Project's frozen logo
 * snapshot is authoritative again.
 */
export function applyCampaignStyleChange(
  document: EditorDocument,
  style: BrandTemplateSnapshot | null,
  resetLogoToProject: boolean,
): EditorDocument {
  let next = document;
  if (style) {
    const captionPreset = {
      ...document.captionPreset,
      ...style.captionPreset,
      positionX: document.captionPreset.positionX,
      positionY: document.captionPreset.positionY,
      fontSize: document.captionPreset.fontSize,
    };
    // Studio preserves clip-local caption coordinates. JSON transport omits
    // absent optional coordinates; the service reducer must produce the same
    // canonical value before writing directly through Prisma.
    if (captionPreset.positionX === undefined) delete captionPreset.positionX;
    if (captionPreset.positionY === undefined) delete captionPreset.positionY;
    next = applyEditorAction(document, {
      type: "setCaptionPreset",
      captionPreset,
    });
  }
  if (resetLogoToProject) {
    next = applyEditorAction(next, {
      type: "setStudioEdits",
      studioEdits: { ...next.studioEdits, logo: INHERITED_STUDIO_LOGO },
    });
  }
  return next;
}

async function resolveProjectBrandProfileSelection(
  scope: Pick<CampaignBrandActorScope, "workspaceId" | "projectId">,
  input: ApplyProjectBrandProfileSelectedInput,
) {
  const project = await requirePrisma().project.findFirst({
    where: { id: scope.projectId, workspaceId: scope.workspaceId },
    select: {
      brandProfileId: true,
      brandProfileSnapshot: true,
      brandSnapshot: true,
    },
  });
  if (!project) {
    throw new CampaignOperationError(
      "campaign_project_not_found",
      "Project was not found",
    );
  }
  if (!project.brandProfileId || project.brandProfileSnapshot == null) {
    throw new CampaignOperationError(
      "campaign_project_brand_profile_missing",
      "This Project does not have a Brand Profile",
    );
  }
  const profile = brandProfileSnapshotSchema.safeParse(
    project.brandProfileSnapshot,
  );
  const style = project.brandSnapshot == null
    ? { success: true as const, data: null }
    : brandTemplateSnapshotSchema.safeParse(project.brandSnapshot);
  if (!profile.success || !style.success) {
    throw new CampaignOperationError(
      "campaign_project_brand_profile_invalid",
      "The Project Brand Profile snapshot is invalid",
    );
  }
  if (
    profile.data.profileId !== project.brandProfileId ||
    JSON.stringify(profile.data.style) !== JSON.stringify(style.data)
  ) {
    throw new CampaignOperationError(
      "campaign_project_brand_profile_invalid",
      "The Project profile and style snapshots do not match",
    );
  }
  const profileFingerprint = fingerprint(profile.data);
  const styleFingerprint = style.data ? fingerprint(style.data) : null;
  if (
    profileFingerprint !== input.profileFingerprint ||
    styleFingerprint !== input.styleFingerprint
  ) {
    throw new CampaignOperationError(
      "campaign_brand_profile_stale",
      "The Project Brand Profile changed after preview",
    );
  }
  return {
    profile: profile.data,
    style: style.data,
    profileFingerprint,
    styleFingerprint,
  };
}

async function resolveMemberStyleSelection(
  scope: Pick<CampaignBrandActorScope, "workspaceId" | "projectId">,
  input: ApplyStyleSelectedInput,
) {
  const prisma = requirePrisma();
  const project = await prisma.project.findFirst({
    where: { id: scope.projectId, workspaceId: scope.workspaceId },
    select: { brandProfileId: true },
  });
  if (!project) {
    throw new CampaignOperationError(
      "campaign_project_not_found",
      "Project was not found",
    );
  }
  if (!project.brandProfileId) {
    throw new CampaignOperationError(
      "campaign_project_brand_profile_missing",
      "Choose a Project Brand Profile before applying a style",
    );
  }
  const membership = await prisma.brandProfileTemplate.findFirst({
    where: {
      profileId: project.brandProfileId,
      templateId: input.templateId,
      profile: { deletedAt: null },
      template: { deletedAt: null },
    },
    include: { template: true },
  });
  if (!membership) {
    throw new CampaignOperationError(
      "campaign_style_not_member",
      "The selected style is not a member of this Project Brand Profile",
    );
  }
  const style = brandTemplateService.buildSnapshot(membership.template);
  const templateFingerprint = fingerprint(style);
  if (templateFingerprint !== input.templateFingerprint) {
    throw new CampaignOperationError(
      "campaign_style_stale",
      "The selected style changed after preview",
    );
  }
  return {
    profileId: project.brandProfileId,
    style,
    templateFingerprint,
  };
}

function campaignOperationSnapshot(operation: CampaignOperationSnapshot) {
  return {
    operationId: operation.id,
    status: operation.status,
    requestedCount: operation.requestedCount,
    counts: {
      succeeded: operation.succeededCount,
      unchanged: operation.unchangedCount,
      stale: operation.staleCount,
      ineligible: operation.ineligibleCount,
      failed: operation.failedCount,
    },
  };
}

function storedRenderResult(value: Prisma.JsonValue | null): RenderResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, Prisma.JsonValue>;
  if (typeof result.workflowRunId !== "string" || typeof result.acceptedAt !== "string" || typeof result.initialSeq !== "number" || typeof result.clipCount !== "number" || typeof result.variantCount !== "number" || (result.resolution !== "720p" && result.resolution !== "1080p" && result.resolution !== "4k")) return null;
  return result as RenderResult;
}

type ExportBundleAdmission = { projectId: string; idempotencyKey: string; stage: "export_bundle" };
const defaultExportBundleAdmission = (input: ExportBundleAdmission) => getWorkflowRunLifecycle().admit(input);
type AtomicExportBundleAdmission = <T>(input: ExportBundleAdmission, handoff: (tx: Prisma.TransactionClient, run: { id: string; created: boolean }) => Promise<T>) => Promise<{ id: string; created: boolean; handoff: T }>;

export class CampaignOperationService {
  private readonly admitExportBundleWithHandoff: AtomicExportBundleAdmission | null;

  constructor(private readonly admitExportBundle: (input: ExportBundleAdmission) => Promise<{ id: string }> = defaultExportBundleAdmission) {
    this.admitExportBundleWithHandoff = admitExportBundle === defaultExportBundleAdmission
      ? (input, handoff) => getWorkflowRunLifecycle().admitWithHandoff(input, handoff)
      : null;
  }

  private async applySelectedEditorDocumentChange(
    scope: Pick<
      CampaignBrandActorScope,
      | "actorUserId"
      | "workspaceId"
      | "workspaceOwnerUserId"
      | "projectId"
      | "pricingTier"
      | "idempotencyKey"
      | "retryOfId"
    >,
    input: {
      action: SelectedEditorAction;
      clips: SelectedEditorItem[];
      requestFingerprint: string;
      validatedOptions: Prisma.InputJsonValue;
      resultReference: Prisma.InputJsonObject;
      change(document: EditorDocument): EditorDocument;
    },
  ): Promise<ApplyCampaignStyleResult> {
    const prisma = requirePrisma();
    const replay = await prisma.campaignOperation.findUnique({
      where: {
        workspaceId_projectId_action_idempotencyKey: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          action: input.action,
          idempotencyKey: scope.idempotencyKey,
        },
      },
    });
    if (replay) {
      if (replay.requestFingerprint !== input.requestFingerprint) {
        throw new CampaignOperationError(
          "campaign_operation_idempotency_conflict",
          "Idempotency key was reused with different input",
        );
      }
      if (replay.status !== "running") {
        return { ...campaignOperationSnapshot(replay), replayed: true };
      }
    }
    if (!replay) {
      await assertCampaignEditorRetry({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        action: input.action,
        retryOfId: scope.retryOfId,
        clips: input.clips,
      });
    }

    const clips = await prisma.clip.findMany({
      where: {
        id: { in: input.clips.map((clip) => clip.clipId) },
        projectId: scope.projectId,
        project: { workspaceId: scope.workspaceId },
      },
      select: { id: true },
    });
    const knownIds = new Set(clips.map((clip) => clip.id));
    let operation: CampaignOperationSnapshot | undefined = replay ?? undefined;
    if (!operation) {
      try {
        operation = await prisma.campaignOperation.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            actorUserId: scope.actorUserId,
            action: input.action,
            idempotencyKey: scope.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            validatedOptions: input.validatedOptions,
            pricingTier: scope.pricingTier,
            requestedCount: input.clips.length,
            retryOfId: scope.retryOfId ?? null,
            items: {
              create: input.clips.map((clip) => ({
                requestedClipId: clip.clipId,
                clipId: knownIds.has(clip.clipId) ? clip.clipId : null,
                expectedEditorRevision: clip.expectedEditorRevision,
                status: knownIds.has(clip.clipId) ? "pending" : "ineligible",
                errorCode: knownIds.has(clip.clipId)
                  ? null
                  : "campaign_clip_not_found",
                settledAt: knownIds.has(clip.clipId) ? null : new Date(),
              })),
            },
          },
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2002"
        ) {
          throw error;
        }
        await throwIfCampaignRetryAlreadyExists(scope.retryOfId);
        const raced = await prisma.campaignOperation.findUnique({
          where: {
            workspaceId_projectId_action_idempotencyKey: {
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              action: input.action,
              idempotencyKey: scope.idempotencyKey,
            },
          },
        });
        if (!raced || raced.requestFingerprint !== input.requestFingerprint) {
          throw new CampaignOperationError(
            "campaign_operation_idempotency_conflict",
            "Idempotency key was reused with different input",
          );
        }
        return this.applySelectedEditorDocumentChange(scope, input);
      }
    }
    if (!operation) {
      throw new CampaignOperationError(
        "campaign_operation_admission_failed",
        "Campaign operation could not be admitted",
      );
    }

    await prisma.campaignOperationItem.updateMany({
      where: {
        operationId: operation.id,
        status: "processing",
        leaseExpiresAt: { lte: new Date() },
      },
      data: { status: "pending", claimToken: null, leaseExpiresAt: null },
    });
    for (const requested of boundedCampaignOperationItems(
      input.clips.filter((clip) => knownIds.has(clip.clipId)),
    )) {
      const claimToken = randomUUID();
      const claimed = await prisma.campaignOperationItem.updateMany({
        where: {
          operationId: operation.id,
          requestedClipId: requested.clipId,
          status: "pending",
        },
        data: {
          status: "processing",
          claimToken,
          leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
      if (claimed.count !== 1) continue;

      let status = "failed";
      let errorCode: string | null = "campaign_style_apply_failed";
      let result: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
      try {
        const current = await clipEditorDocumentPersistence.readDocument({
          actorUserId: scope.actorUserId,
          workspaceId: scope.workspaceId,
          workspaceOwnerUserId: scope.workspaceOwnerUserId,
          projectId: scope.projectId,
          clipId: requested.clipId,
        });
        const next = input.change(current.document);
        if (current.revision !== requested.expectedEditorRevision) {
          status = "stale";
          errorCode = "campaign_clip_stale";
        } else if (next === current.document) {
          status = "unchanged";
          errorCode = null;
          result = {
            editorRevision: current.revision,
            ...input.resultReference,
          };
        } else {
          const mutation = await clipEditorDocumentPersistence.mutateDocument({
            actorUserId: scope.actorUserId,
            workspaceId: scope.workspaceId,
            workspaceOwnerUserId: scope.workspaceOwnerUserId,
            projectId: scope.projectId,
            clipId: requested.clipId,
            intent: {
              kind: "replace",
              baseRevision: current.revision,
              document: next,
            },
          });
          status = mutation.noop ? "unchanged" : "succeeded";
          errorCode = null;
          result = {
            editorRevision: mutation.revision,
            ...input.resultReference,
          };
        }
      } catch (error) {
        if (error instanceof ClipEditorRevisionConflictError) {
          status = "stale";
          errorCode = "campaign_clip_stale";
        }
      }
      await prisma.campaignOperationItem.updateMany({
        where: {
          operationId: operation.id,
          requestedClipId: requested.clipId,
          status: "processing",
          claimToken,
        },
        data: {
          status,
          errorCode,
          result,
          settledAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        },
      });
    }

    const grouped = await prisma.campaignOperationItem.groupBy({
      by: ["status"],
      where: { operationId: operation.id },
      _count: { _all: true },
    });
    const count = (status: string) =>
      grouped.find((entry) => entry.status === status)?._count._all ?? 0;
    if (count("pending") + count("processing") > 0) {
      const running = await prisma.campaignOperation.findUniqueOrThrow({
        where: { id: operation.id },
      });
      return { ...campaignOperationSnapshot(running), replayed: replay !== null };
    }
    const counts = {
      succeeded: count("succeeded"),
      unchanged: count("unchanged"),
      stale: count("stale"),
      ineligible: count("ineligible"),
      failed: count("failed"),
    };
    const settled = await prisma.campaignOperation.update({
      where: { id: operation.id },
      data: {
        status:
          counts.stale + counts.ineligible + counts.failed > 0
            ? "partial"
            : "completed",
        succeededCount: counts.succeeded,
        unchangedCount: counts.unchanged,
        staleCount: counts.stale,
        ineligibleCount: counts.ineligible,
        failedCount: counts.failed,
        completedAt: new Date(),
      },
    });
    return { ...campaignOperationSnapshot(settled), replayed: false };
  }

  async renderSelected(input: {
    actorUserId: string;
    workspaceId: string;
    projectId: string;
    pricingTier: PricingTier;
    idempotencyKey: string;
    clipIds: string[];
    aspectRatios?: ClipAspectRatio[];
    resolution: ClipRenderResolution;
    retryOfId?: string;
    execute(clipIds: string[]): Promise<RenderResult>;
  }): Promise<RenderResult | (RenderResult & { operationId: string; replayed: boolean })> {
    const normalizedIds = [...new Set(input.clipIds)].sort();
    // Recording the pre-existing render-selected path is a rollout concern,
    // not a paid entitlement. With recording disabled, preserve its exact
    // response and availability on every plan.
    if (!campaignActionWriteEnabled("render_selected")) {
      return input.execute(normalizedIds);
    }
    const requestFingerprint = fingerprint({ action: "render_selected", clipIds: normalizedIds, aspectRatios: input.aspectRatios ?? null, resolution: input.resolution, retryOfId: input.retryOfId ?? null });
    const prisma = requirePrisma();
    const replay = await prisma.campaignOperation.findUnique({
      where: { workspaceId_projectId_action_idempotencyKey: { workspaceId: input.workspaceId, projectId: input.projectId, action: "render_selected", idempotencyKey: input.idempotencyKey } },
      include: { items: { select: { requestedClipId: true, status: true, result: true } } },
    });
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new CampaignOperationError("campaign_operation_idempotency_conflict", "Idempotency key was reused with different input");
      const completedResult = replay.status === "completed" || replay.status === "partial"
        ? replay.items.map((item) => storedRenderResult(item.result)).find((result) => result !== null) ?? null
        : null;
      if (completedResult) return { ...completedResult, operationId: replay.id, replayed: true };
      await prisma.campaignOperation.updateMany({ where: { id: replay.id, status: "running", leaseExpiresAt: { lte: new Date() } }, data: { claimToken: null, leaseExpiresAt: null } });
      const claimToken = randomUUID();
      const claimed = await prisma.campaignOperation.updateMany({ where: { id: replay.id, status: "running", claimToken: null }, data: { claimToken, leaseExpiresAt: new Date(Date.now() + 10 * 60_000) } });
      if (claimed.count !== 1) throw new CampaignOperationError("campaign_operation_in_progress", "Campaign operation is already in progress");
      const resumableIds = replay.items.filter((item) => item.status === "pending" || item.status === "succeeded").map((item) => item.requestedClipId);
      if (resumableIds.length === 0) throw new CampaignOperationError("campaign_operation_not_retryable", "Campaign operation has no resumable items");
      try {
        const result = await input.execute(resumableIds);
        await prisma.$transaction(async (tx) => {
          const owned = await tx.campaignOperation.updateMany({ where: { id: replay.id, status: "running", claimToken }, data: { status: resumableIds.length === replay.requestedCount ? "completed" : "partial", workflowRunId: result.workflowRunId, succeededCount: resumableIds.length, ineligibleCount: replay.requestedCount - resumableIds.length, completedAt: new Date(), claimToken: null, leaseExpiresAt: null } });
          if (owned.count !== 1) throw new CampaignOperationError("campaign_operation_claim_lost", "Campaign operation ownership was lost");
          await tx.campaignOperationItem.updateMany({ where: { operationId: replay.id, status: "pending" }, data: { status: "succeeded", result: result as Prisma.InputJsonValue, settledAt: new Date() } });
        });
        return { ...result, operationId: replay.id, replayed: true };
      } catch (error) {
        await prisma.$transaction(async (tx) => {
          const owned = await tx.campaignOperation.updateMany({ where: { id: replay.id, status: "running", claimToken }, data: { status: "failed", failedCount: resumableIds.length, completedAt: new Date(), claimToken: null, leaseExpiresAt: null } });
          if (owned.count === 1) await tx.campaignOperationItem.updateMany({ where: { operationId: replay.id, status: "pending" }, data: { status: "failed", errorCode: "campaign_render_admission_failed", settledAt: new Date() } });
        });
        throw error;
      }
    }
    const clips = await prisma.clip.findMany({ where: { projectId: input.projectId, id: { in: normalizedIds }, project: { workspaceId: input.workspaceId } }, select: { id: true, editorRevision: true } });
    const byId = new Map(clips.map((clip) => [clip.id, clip]));
    let operation;
    const operationClaimToken = randomUUID();
    try {
      operation = await prisma.campaignOperation.create({ data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        action: "render_selected",
        retryOfId: input.retryOfId ?? null,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
				validatedOptions: { aspectRatios: input.aspectRatios ?? [], resolution: input.resolution },
				pricingTier: input.pricingTier,
        requestedCount: normalizedIds.length,
        claimToken: operationClaimToken,
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
        items: { create: normalizedIds.map((clipId) => ({ requestedClipId: clipId, clipId: byId.has(clipId) ? clipId : null, expectedEditorRevision: byId.get(clipId)?.editorRevision ?? null, status: byId.has(clipId) ? "pending" : "ineligible", errorCode: byId.has(clipId) ? null : "campaign_clip_not_found" })) },
      } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const raced = await prisma.campaignOperation.findUnique({
        where: { workspaceId_projectId_action_idempotencyKey: { workspaceId: input.workspaceId, projectId: input.projectId, action: "render_selected", idempotencyKey: input.idempotencyKey } },
        include: { items: { select: { requestedClipId: true, status: true } } },
      });
      if (!raced || raced.requestFingerprint !== requestFingerprint) throw new CampaignOperationError("campaign_operation_idempotency_conflict", "Idempotency key was reused with different input");
      return this.renderSelected(input);
    }
    const eligible = normalizedIds.filter((clipId) => byId.has(clipId));
    if (eligible.length === 0) {
      await prisma.campaignOperation.update({ where: { id: operation.id }, data: { status: "failed", ineligibleCount: normalizedIds.length, completedAt: new Date(), claimToken: null, leaseExpiresAt: null } });
      throw new CampaignOperationError("campaign_operation_no_eligible_items", "No selected clips are eligible");
    }
    try {
      const result = await input.execute(eligible);
      await prisma.$transaction(async (tx) => {
        const owned = await tx.campaignOperation.updateMany({ where: { id: operation.id, status: "running", claimToken: operationClaimToken }, data: { status: eligible.length === normalizedIds.length ? "completed" : "partial", workflowRunId: result.workflowRunId, succeededCount: eligible.length, ineligibleCount: normalizedIds.length - eligible.length, completedAt: new Date(), claimToken: null, leaseExpiresAt: null } });
        if (owned.count !== 1) throw new CampaignOperationError("campaign_operation_claim_lost", "Campaign operation ownership was lost");
        await tx.campaignOperationItem.updateMany({ where: { operationId: operation.id, status: "pending" }, data: { status: "succeeded", result: result as Prisma.InputJsonValue, settledAt: new Date() } });
      });
      return { ...result, operationId: operation.id, replayed: false };
    } catch (error) {
      await prisma.$transaction(async (tx) => {
        const owned = await tx.campaignOperation.updateMany({ where: { id: operation.id, status: "running", claimToken: operationClaimToken }, data: { status: "failed", failedCount: eligible.length, ineligibleCount: normalizedIds.length - eligible.length, completedAt: new Date(), claimToken: null, leaseExpiresAt: null } });
        if (owned.count === 1) await tx.campaignOperationItem.updateMany({ where: { operationId: operation.id, status: "pending" }, data: { status: "failed", errorCode: "campaign_render_admission_failed", settledAt: new Date() } });
      });
      throw error;
    }
  }

  async retryRenderSelected(input: {
    actorUserId: string;
    workspaceId: string;
    projectId: string;
    pricingTier: PricingTier;
    sourceOperationId: string;
    idempotencyKey: string;
    aspectRatios?: ClipAspectRatio[];
    resolution: ClipRenderResolution;
    execute(clipIds: string[]): Promise<RenderResult>;
  }) {
    assertCampaignActionWriteEnabled("render_selected");
    const source = await requirePrisma().campaignOperation.findFirst({
      where: {
        id: input.sourceOperationId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        action: "render_selected",
      },
      include: { items: true, retries: { select: { id: true }, take: 1 } },
    });
    if (!source) throw new CampaignOperationError("campaign_operation_not_found", "Campaign operation was not found");
    if (source.retries.length > 0) throw new CampaignOperationError("campaign_operation_already_retried", "This campaign operation already has a retry");
    const retryableIds = source.items
      .filter((item) => item.status === "failed" && item.errorCode === "campaign_render_admission_failed")
      .map((item) => item.requestedClipId);
    if (retryableIds.length === 0) throw new CampaignOperationError("campaign_operation_no_retryable_items", "This campaign operation has no retryable items");
    try {
      return await this.renderSelected({
        ...input,
        clipIds: retryableIds,
        retryOfId: source.id,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new CampaignOperationError("campaign_operation_already_retried", "This campaign operation already has a retry");
      }
      throw error;
    }
  }

  async listExportBundles(scope: { workspaceId: string; projectId: string }) {
    const bundles = await requirePrisma().exportBundle.findMany({
      where: { operation: { workspaceId: scope.workspaceId, projectId: scope.projectId } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { operation: { select: { id: true, status: true, requestedCount: true, succeededCount: true, staleCount: true, ineligibleCount: true, failedCount: true } } },
    });
    const now = new Date();
    return bundles.map((bundle) => ({
      id: bundle.id,
      operationId: bundle.operationId,
      workflowRunId: bundle.workflowRunId,
      status: bundle.status === "completed" && bundle.expiresAt && bundle.expiresAt <= now ? "expired" : bundle.status,
      sizeBytes: bundle.sizeBytes?.toString() ?? null,
      checksumSha256: bundle.checksumSha256,
      expiresAt: bundle.expiresAt,
      createdAt: bundle.createdAt,
      completedAt: bundle.completedAt,
      errorCode: bundle.errorCode,
      operation: bundle.operation,
    }));
  }

  async listOperations(scope: { workspaceId: string; projectId: string }) {
    return requirePrisma().campaignOperation.findMany({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        items: { orderBy: { requestedClipId: "asc" }, select: { id: true, requestedClipId: true, clipId: true, expectedEditorRevision: true, status: true, errorCode: true, settledAt: true } },
        bundle: { select: { id: true, status: true, expiresAt: true, errorCode: true } },
        retries: { select: { id: true, status: true, createdAt: true } },
      },
    });
  }

  async getExportBundle(scope: { workspaceId: string; projectId: string }, bundleId: string) {
    const bundle = (await this.listExportBundles(scope)).find((candidate) => candidate.id === bundleId);
    if (!bundle) throw new CampaignOperationError("export_bundle_not_found", "Export bundle was not found");
    return bundle;
  }

  async getExportBundleDownload(scope: CampaignBundleAccessScope, bundleId: string) {
    assertCampaignBundleAllowed(scope);
    const bundle = await requirePrisma().exportBundle.findFirst({
      where: { id: bundleId, operation: { workspaceId: scope.workspaceId, projectId: scope.projectId } },
      select: { status: true, storageKey: true, expiresAt: true },
    });
    if (!bundle) throw new CampaignOperationError("export_bundle_not_found", "Export bundle was not found");
    if (bundle.expiresAt && bundle.expiresAt <= new Date()) throw new CampaignOperationError("export_bundle_expired", "Export bundle has expired");
    if (bundle.status !== "completed" || !bundle.storageKey) throw new CampaignOperationError("export_bundle_not_ready", "Export bundle is not ready for download");
    return presignDownloadUrl({ key: bundle.storageKey, expiresIn: 60, fileName: `narriflow-export-${bundleId}.zip` });
  }

  async previewExportBundle(
    scope: CampaignBundleAccessScope & { pricingTier: PricingTier },
    value: unknown,
  ) {
    assertCampaignActionWriteEnabled("export_bundle");
    assertCampaignBundleAllowed(scope);
    if (!hasFeature(scope.pricingTier, "export.bundles")) {
      throw new CampaignOperationError(
        "export_bundle_feature_unavailable",
        "Export bundles are not available on this plan",
      );
    }
    const input = createExportBundleSchema.parse(value);
    const selection = await resolveExportBundleSelection(scope, input);
    const counts = selection.items.reduce(
      (result, item) => {
        result[item.status] += 1;
        return result;
      },
      { eligible: 0, stale: 0, ineligible: 0 },
    );
    return {
      requestedCount: input.clips.length,
      counts,
      estimatedSizeBytes: selection.items.reduce(
        (total, item) => total + item.estimatedSizeBytes,
        0,
      ),
      items: selection.items,
    };
  }

  async retryExportBundle(scope: CampaignBundleActorScope, bundleId: string) {
		assertCampaignActionWriteEnabled("export_bundle");
		assertCampaignBundleAllowed(scope);
		const bundle = await requirePrisma().exportBundle.findFirst({
      where: { id: bundleId, operation: { workspaceId: scope.workspaceId, projectId: scope.projectId, action: "export_bundle" } },
			select: { operationId: true },
    });
		if (!bundle) throw new CampaignOperationError("export_bundle_not_found", "Export bundle was not found");
		return this.retryExportBundleOperation(scope, bundle.operationId);
	}

	async retryExportBundleOperation(scope: CampaignBundleActorScope, operationId: string) {
		assertCampaignActionWriteEnabled("export_bundle");
		assertCampaignBundleAllowed(scope);
		const source = await requirePrisma().campaignOperation.findFirst({
			where: { id: operationId, workspaceId: scope.workspaceId, projectId: scope.projectId, action: "export_bundle" },
			include: { items: true, retries: { select: { id: true }, take: 1 } },
		});
		if (!source) throw new CampaignOperationError("campaign_operation_not_found", "Campaign operation was not found");
		if (source.retries.length > 0) throw new CampaignOperationError("campaign_operation_already_retried", "This campaign operation already has a retry");
		const retryable = source.items.filter((item) => item.status === "failed" &&
			(item.errorCode === "export_bundle_build_failed" || item.errorCode === "export_bundle_admission_failed") &&
			item.expectedEditorRevision !== null);
		if (retryable.length === 0) throw new CampaignOperationError("campaign_operation_no_retryable_items", "This export bundle has no retryable items");
		const storedInput = createExportBundleSchema.parse(source.validatedOptions);
		return this.createExportBundle({ ...scope, retryOfId: source.id }, {
			clips: retryable.map((item) => ({ clipId: item.requestedClipId, expectedEditorRevision: item.expectedEditorRevision! })),
			aspectRatios: storedInput.aspectRatios,
			resolution: storedInput.resolution,
		});
  }

  async createExportBundle(scope: CampaignBundleActorScope, value: unknown): Promise<{ operationId: string; workflowRunId: string; manifest: ExportBundleManifest; replayed: boolean }> {
    assertCampaignActionWriteEnabled("export_bundle");
    assertCampaignBundleAllowed(scope);
    if (!hasFeature(scope.pricingTier, "export.bundles")) throw new CampaignOperationError("export_bundle_feature_unavailable", "Export bundles are not available on this plan");
    const input = createExportBundleSchema.parse(value);
    const expiresAt = new Date(Date.now() + exportBundleRetentionMs());
    if (new Set(input.clips.map((clip) => clip.clipId)).size !== input.clips.length) {
      throw new CampaignOperationError("export_bundle_duplicate_clip", "A clip can appear only once in an export bundle");
    }
    const requestFingerprint = fingerprint({
      action: "export_bundle",
      retryOfId: scope.retryOfId ?? null,
      ...input,
    });
    const prisma = requirePrisma();
    const replay = await prisma.campaignOperation.findUnique({
      where: { workspaceId_projectId_action_idempotencyKey: { workspaceId: scope.workspaceId, projectId: scope.projectId, action: "export_bundle", idempotencyKey: scope.idempotencyKey } },
      include: { bundle: true },
    });
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new CampaignOperationError("campaign_operation_idempotency_conflict", "Idempotency key was reused with different input");
      if (replay.bundle && replay.workflowRunId) return {
          operationId: replay.id,
          workflowRunId: replay.workflowRunId,
          manifest: exportBundleManifestSchema.parse(replay.bundle.manifest),
          replayed: true,
        };
    }
    const operationClaimToken = randomUUID();
    if (replay) {
      await prisma.campaignOperation.updateMany({ where: { id: replay.id, status: "running", leaseExpiresAt: { lte: new Date() } }, data: { claimToken: null, leaseExpiresAt: null } });
      const claimed = await prisma.campaignOperation.updateMany({ where: { id: replay.id, status: "running", claimToken: null }, data: { claimToken: operationClaimToken, leaseExpiresAt: new Date(Date.now() + 10 * 60_000) } });
      if (claimed.count !== 1) throw new CampaignOperationError("campaign_operation_in_progress", "Campaign operation is already in progress");
    }
    const selection = await resolveExportBundleSelection(scope, input);
    const { clipsById, eligible } = selection;
    const names = allocateBundleFileNames(eligible.map(({ clip, variants }) => ({ clipId: clip.id, title: clip.title, variants: variants.map((variant) => ({ id: variant.id, aspectRatio: clipAspectRatioFromDb[variant.aspectRatio] })) })));
    let operation: { id: string; createdAt: Date } | undefined = replay ? { id: replay.id, createdAt: replay.createdAt } : undefined;
    if (!operation) try {
      operation = await prisma.campaignOperation.create({ data: {
        workspaceId: scope.workspaceId, projectId: scope.projectId, actorUserId: scope.actorUserId,
        action: "export_bundle", idempotencyKey: scope.idempotencyKey, requestFingerprint, requestedCount: input.clips.length,
				validatedOptions: input,
				pricingTier: scope.pricingTier,
        retryOfId: scope.retryOfId ?? null,
        status: "running",
        claimToken: operationClaimToken,
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
        items: { create: input.clips.map((item) => {
          const selected = eligible.find(({ clip }) => clip.id === item.clipId);
          const named = names.find((entry) => entry.clipId === item.clipId);
          const known = clipsById.get(item.clipId);
          const code = selection.items.find(
            (candidate) => candidate.clipId === item.clipId,
          )?.code ?? "export_variant_unavailable";
          return { requestedClipId: item.clipId, clipId: known ? item.clipId : null, expectedEditorRevision: item.expectedEditorRevision, exportId: selected?.frozen.id ?? null, status: selected ? "pending" : code === "campaign_clip_stale" ? "stale" : "ineligible", errorCode: selected ? null : code, result: selected ? { files: named?.files ?? [] } : Prisma.JsonNull, settledAt: selected ? null : new Date() };
        }) },
      } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const raced = await prisma.campaignOperation.findUnique({
        where: { workspaceId_projectId_action_idempotencyKey: { workspaceId: scope.workspaceId, projectId: scope.projectId, action: "export_bundle", idempotencyKey: scope.idempotencyKey } },
        include: { bundle: true },
      });
      if (!raced || raced.requestFingerprint !== requestFingerprint) throw new CampaignOperationError("campaign_operation_idempotency_conflict", "Idempotency key was reused with different input");
      return this.createExportBundle(scope, value);
    }
    if (!operation) throw new CampaignOperationError("campaign_operation_admission_failed", "Campaign operation could not be admitted");
    const included = eligible.map(({ clip, frozen, variants }) => ({
      clipId: clip.id, exportId: frozen.id, editorRevision: frozen.editorRevision,
      files: variants.map((variant) => ({ variantId: variant.id, aspectRatio: clipAspectRatioFromDb[variant.aspectRatio], name: names.find((entry) => entry.clipId === clip.id)!.files.find((file) => file.variantId === variant.id)!.name, sizeBytes: Number(variant.sizeBytes) })),
    }));
    const includedIds = new Set(included.map((item) => item.clipId));
    const excluded = selection.items
      .filter((item) => !includedIds.has(item.clipId))
      .map((item) => ({
        clipId: item.clipId,
        code: item.code ?? "export_variant_unavailable",
      }));
    if (included.length === 0) {
      await prisma.campaignOperation.updateMany({ where: { id: operation.id, claimToken: operationClaimToken }, data: { status: "failed", staleCount: excluded.filter((item) => item.code === "campaign_clip_stale").length, ineligibleCount: excluded.filter((item) => item.code !== "campaign_clip_stale").length, completedAt: new Date(), claimToken: null, leaseExpiresAt: null } });
      throw new CampaignOperationError("export_bundle_empty", "No selected exports are available for this bundle");
    }
    const manifest = exportBundleManifestSchema.parse({ schemaVersion: 1, operationId: operation.id, projectId: scope.projectId, createdAt: operation.createdAt.toISOString(), included, excluded });
    try {
      const admissionInput = { projectId: scope.projectId, idempotencyKey: `bundle:${scope.idempotencyKey}`, stage: "export_bundle" as const };
      let admitted: { id: string };
      if (this.admitExportBundleWithHandoff) {
        admitted = await this.admitExportBundleWithHandoff(admissionInput, async (tx, run) => {
          await tx.exportBundle.create({ data: { operationId: operation.id, workflowRunId: run.id, manifest: manifest as Prisma.InputJsonValue, expiresAt } });
          const owned = await tx.campaignOperation.updateMany({ where: { id: operation.id, status: "running", claimToken: operationClaimToken }, data: { workflowRunId: run.id, staleCount: excluded.filter((item) => item.code === "campaign_clip_stale").length, ineligibleCount: excluded.filter((item) => item.code !== "campaign_clip_stale").length, claimToken: null, leaseExpiresAt: null } });
          if (owned.count !== 1) throw new CampaignOperationError("campaign_operation_claim_lost", "Campaign operation ownership was lost");
          return null;
        });
      } else {
        admitted = await this.admitExportBundle(admissionInput);
        await prisma.$transaction([
          prisma.exportBundle.create({ data: { operationId: operation.id, workflowRunId: admitted.id, manifest: manifest as Prisma.InputJsonValue, expiresAt } }),
          prisma.campaignOperation.updateMany({ where: { id: operation.id, status: "running", claimToken: operationClaimToken }, data: { workflowRunId: admitted.id, staleCount: excluded.filter((item) => item.code === "campaign_clip_stale").length, ineligibleCount: excluded.filter((item) => item.code !== "campaign_clip_stale").length, claimToken: null, leaseExpiresAt: null } }),
        ]);
      }
      return { operationId: operation.id, workflowRunId: admitted.id, manifest, replayed: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await prisma.exportBundle.findUnique({ where: { operationId: operation.id } });
        if (existing) return { operationId: operation.id, workflowRunId: existing.workflowRunId, manifest: exportBundleManifestSchema.parse(existing.manifest), replayed: true };
      }
      await prisma.$transaction([
        prisma.campaignOperationItem.updateMany({ where: { operationId: operation.id, status: "pending" }, data: { status: "failed", errorCode: "export_bundle_admission_failed", settledAt: new Date() } }),
        prisma.campaignOperation.updateMany({ where: { id: operation.id, claimToken: operationClaimToken }, data: { status: "failed", succeededCount: 0, failedCount: included.length, staleCount: excluded.filter((item) => item.code === "campaign_clip_stale").length, ineligibleCount: excluded.filter((item) => item.code !== "campaign_clip_stale").length, completedAt: new Date(), claimToken: null, leaseExpiresAt: null } }),
      ]).catch(() => undefined);
      throw error;
    }
  }

  async getEditorActionCatalog(
    scope: BrandActorScope & { projectId: string },
  ) {
    if (
      !workspaceAllowsCapability(
        { role: scope.role, status: scope.status },
        "content.view",
      )
    ) {
      throw new CampaignOperationError(
        "campaign_operation_forbidden",
        "Campaign styles cannot be viewed with this Workspace role",
      );
    }
    const project = await requirePrisma().project.findFirst({
      where: { id: scope.projectId, workspaceId: scope.workspaceId },
      select: {
        brandProfileId: true,
        brandProfileSnapshot: true,
        brandSnapshot: true,
        brandProfile: {
          select: {
            id: true,
            deletedAt: true,
            defaultTemplateId: true,
            defaultIntroSceneTemplateId: true,
            defaultOutroSceneTemplateId: true,
            templates: {
              where: { template: { deletedAt: null } },
              orderBy: [{ position: "asc" }, { templateId: "asc" }],
              include: { template: true },
            },
            sceneTemplates: {
              where: {
                deletedAt: null,
                role: { in: ["intro", "outro"] },
              },
              orderBy: [{ role: "asc" }, { name: "asc" }],
              select: {
                id: true,
                name: true,
                role: true,
                definition: true,
                fingerprint: true,
              },
            },
          },
        },
      },
    });
    if (!project) {
      throw new CampaignOperationError(
        "campaign_project_not_found",
        "Project was not found",
      );
    }

    const profile = project.brandProfileSnapshot == null
      ? null
      : brandProfileSnapshotSchema.safeParse(project.brandProfileSnapshot);
    const currentStyle = project.brandSnapshot == null
      ? null
      : brandTemplateSnapshotSchema.safeParse(project.brandSnapshot);
    if (profile && !profile.success) {
      throw new CampaignOperationError(
        "campaign_project_brand_profile_invalid",
        "The Project Brand Profile snapshot is invalid",
      );
    }
    if (currentStyle && !currentStyle.success) {
      throw new CampaignOperationError(
        "campaign_project_brand_profile_invalid",
        "The Project style snapshot is invalid",
      );
    }
    const frozenProfile = profile?.data ?? null;
    const frozenStyle = currentStyle?.data ?? null;
    if (
      frozenProfile &&
      JSON.stringify(frozenProfile.style) !== JSON.stringify(frozenStyle)
    ) {
      throw new CampaignOperationError(
        "campaign_project_brand_profile_invalid",
        "The Project profile and style snapshots do not match",
      );
    }

    const liveProfile =
      project.brandProfileId &&
      project.brandProfile?.id === project.brandProfileId &&
      project.brandProfile.deletedAt == null
        ? project.brandProfile
        : null;
    const styles = (liveProfile?.templates ?? []).flatMap((membership) => {
      const parsed = brandTemplateSnapshotSchema.safeParse(
        brandTemplateService.buildSnapshot(membership.template),
      );
      if (!parsed.success || !parsed.data.templateId) return [];
      return [{
        id: parsed.data.templateId,
        name: membership.template.name,
        fingerprint: fingerprint(parsed.data),
        fontName: parsed.data.captionPreset.fontName,
        captionPosition: parsed.data.captionPreset.position,
        primaryColor: parsed.data.primaryColor,
        secondaryColor: parsed.data.secondaryColor,
        accentColor: parsed.data.accentColor,
        current: parsed.data.templateId === frozenStyle?.templateId,
      }];
    });
    const scenes = (liveProfile?.sceneTemplates ?? []).flatMap((scene) => {
      const definition = sceneTemplateDefinitionSchema.safeParse(scene.definition);
      if (!definition.success || (scene.role !== "intro" && scene.role !== "outro")) {
        return [];
      }
      return [{
        id: scene.id,
        name: scene.name,
        role: scene.role,
        fingerprint: scene.fingerprint,
        durationSec: definition.data.durationSec,
        contentKind: definition.data.content.kind,
        isDefault:
          scene.id === liveProfile?.defaultIntroSceneTemplateId ||
          scene.id === liveProfile?.defaultOutroSceneTemplateId,
      }];
    });
    const currentStyleName = styles.find((style) => style.current)?.name ??
      (frozenStyle ? "Frozen project style" : null);
    return {
      profile: frozenProfile
        ? {
            id: frozenProfile.profileId,
            name: frozenProfile.name,
            fingerprint: fingerprint(frozenProfile),
            styleFingerprint: frozenStyle ? fingerprint(frozenStyle) : null,
            currentStyle: frozenStyle
              ? {
                  id: frozenStyle.templateId,
                  name: currentStyleName,
                  fontName: frozenStyle.captionPreset.fontName,
                  primaryColor: frozenStyle.primaryColor,
                  secondaryColor: frozenStyle.secondaryColor,
                }
              : null,
          }
        : null,
      styles,
      scenes,
    };
  }

  async previewEditorAction(
    scope: BrandActorScope & { projectId: string },
    value: unknown,
  ) {
    if (
      !workspaceAllowsCapability(
        { role: scope.role, status: scope.status },
        "content.view",
      )
    ) {
      throw new CampaignOperationError(
        "campaign_operation_forbidden",
        "Campaign actions cannot be previewed with this Workspace role",
      );
    }
    const request = previewCampaignEditorActionSchema.parse(value);
    let change: (document: EditorDocument) => EditorDocument;
    let sceneTemplate: Awaited<
      ReturnType<typeof sceneTemplateService.freezeForInsertion>
    > | null = null;
    let clips: SelectedEditorItem[];
    let placement: "start" | "end" | null = null;
    let motionChange: ApplyMotionSelectedInput["change"] | null = null;

    if (request.action === "apply_brand_profile") {
      const resolved = await resolveProjectBrandProfileSelection(
        scope,
        request.input,
      );
      change = (document) =>
        applyCampaignStyleChange(document, resolved.style, true);
      clips = request.input.clips;
    } else if (request.action === "apply_style") {
      const resolved = await resolveMemberStyleSelection(scope, request.input);
      change = (document) =>
        applyCampaignStyleChange(document, resolved.style, false);
      clips = request.input.clips;
    } else if (request.action === "apply_scene_template") {
      clips = request.input.clips;
      placement = request.input.placement;
      try {
        sceneTemplate = await sceneTemplateService.freezeForInsertion(
          scope,
          request.profileId,
          request.templateId,
          { id: randomUUID(), anchorSec: 0 },
        );
      } catch (error) {
        if (error instanceof SceneTemplateError) {
          throw new CampaignOperationError(error.code, error.message);
        }
        throw error;
      }
      if (
        sceneTemplate.templateSnapshot?.fingerprint !==
        request.input.templateFingerprint
      ) {
        throw new CampaignOperationError(
          "scene_template_fingerprint_stale",
          "The Scene Template changed after preview",
        );
      }
      change = (document) => document;
    } else {
      clips = request.input.clips;
      motionChange = request.input.change;
      change = (document) => document;
    }

    const known = await requirePrisma().clip.findMany({
      where: {
        id: { in: clips.map((clip) => clip.clipId) },
        projectId: scope.projectId,
        project: { workspaceId: scope.workspaceId },
      },
      select: { id: true },
    });
    const knownIds = new Set(known.map((clip) => clip.id));
    const items: Array<{
      clipId: string;
      expectedEditorRevision: number;
      currentEditorRevision: number | null;
      status: "eligible" | "unchanged" | "stale" | "ineligible";
      code: string | null;
    }> = [];
    for (const selected of clips) {
      if (!knownIds.has(selected.clipId)) {
        items.push({
          clipId: selected.clipId,
          expectedEditorRevision: selected.expectedEditorRevision,
          currentEditorRevision: null,
          status: "ineligible",
          code: "campaign_clip_not_found",
        });
        continue;
      }
      try {
        const current = await clipEditorDocumentPersistence.readDocument({
          actorUserId: scope.actorUserId,
          workspaceId: scope.workspaceId,
          workspaceOwnerUserId: scope.workspaceOwnerUserId,
          projectId: scope.projectId,
          clipId: selected.clipId,
        });
        if (current.revision !== selected.expectedEditorRevision) {
          items.push({
            clipId: selected.clipId,
            expectedEditorRevision: selected.expectedEditorRevision,
            currentEditorRevision: current.revision,
            status: "stale",
            code: "campaign_clip_stale",
          });
          continue;
        }
        let next: EditorDocument;
        let equivalent = false;
        let ineligibleCode: string | null = null;
        if (sceneTemplate && placement) {
          const sourceDurationSec = buildEditedTimeMap(
            current.document.deletedRanges,
            {
              startSec: current.document.clipStartSec,
              endSec: current.document.clipEndSec,
            },
          ).editedDurationSec;
          const totalDurationSec =
            sourceDurationSec +
            current.document.sceneBlocks.reduce(
              (total, scene) => total + scene.durationSec,
              0,
            );
          equivalent = current.document.sceneBlocks.some((scene) =>
            scene.templateSnapshot?.fingerprint ===
              sceneTemplate?.templateSnapshot?.fingerprint &&
            (placement === "start"
              ? Math.abs(scene.anchorSec) <= 0.001
              : Math.abs(
                  scene.anchorSec + scene.durationSec - totalDurationSec,
                ) <= 0.001));
          next = equivalent
            ? current.document
            : applyEditorAction(current.document, {
                type: "insertSceneBlock",
                scene: {
                  ...sceneTemplate,
                  id: randomUUID(),
                  anchorSec: placement === "start" ? 0 : totalDurationSec,
                },
              });
        } else if (motionChange) {
          const planned = applyCampaignMotionChange(
            current.document,
            motionChange,
          );
          equivalent = planned.status === "unchanged";
          if (planned.status === "changed") {
            next = planned.document;
          } else {
            next = current.document;
            if (planned.status === "ineligible" || planned.status === "failed") {
              ineligibleCode = planned.code;
            }
          }
        } else {
          next = change(current.document);
          equivalent = next === current.document;
        }

        if (equivalent) {
          items.push({
            clipId: selected.clipId,
            expectedEditorRevision: selected.expectedEditorRevision,
            currentEditorRevision: current.revision,
            status: "unchanged",
            code: null,
          });
        } else if (ineligibleCode || next === current.document) {
          items.push({
            clipId: selected.clipId,
            expectedEditorRevision: selected.expectedEditorRevision,
            currentEditorRevision: current.revision,
            status: "ineligible",
            code: ineligibleCode ?? "scene_template_document_limit",
          });
        } else {
          items.push({
            clipId: selected.clipId,
            expectedEditorRevision: selected.expectedEditorRevision,
            currentEditorRevision: current.revision,
            status: "eligible",
            code: null,
          });
        }
      } catch (error) {
        const code =
          error instanceof ClipEditorDocumentPersistenceError &&
          (error.code === "clip_not_found" || error.code === "project_not_found")
            ? "campaign_clip_not_found"
            : "campaign_editor_document_invalid";
        items.push({
          clipId: selected.clipId,
          expectedEditorRevision: selected.expectedEditorRevision,
          currentEditorRevision: null,
          status: "ineligible",
          code,
        });
      }
    }
    const count = (status: (typeof items)[number]["status"]) =>
      items.filter((item) => item.status === status).length;
    return {
      action: request.action,
      requestedCount: items.length,
      counts: {
        eligible: count("eligible"),
        unchanged: count("unchanged"),
        stale: count("stale"),
        ineligible: count("ineligible"),
      },
      items,
    };
  }

  async applyProjectBrandProfileSelected(
    scope: CampaignBrandActorScope,
    value: unknown,
  ): Promise<ApplyCampaignStyleResult> {
    assertCampaignActionWriteEnabled("apply_brand_profile");
    assertProgramWriteEnabled("brand_kit_projection");
    assertCampaignBrandApplicationAllowed(scope);
    const input = applyProjectBrandProfileSelectedSchema.parse(value);
    const resolved = await resolveProjectBrandProfileSelection(scope, input);
    const clips = [...input.clips].sort((left, right) =>
      left.clipId.localeCompare(right.clipId),
    );
    return this.applySelectedEditorDocumentChange(scope, {
      action: "apply_brand_profile",
      clips,
      requestFingerprint: fingerprint({
        action: "apply_brand_profile",
        profileFingerprint: resolved.profileFingerprint,
        styleFingerprint: resolved.styleFingerprint,
        clips,
        retryOfId: scope.retryOfId ?? null,
      }),
      validatedOptions: {
        profileId: resolved.profile.profileId,
        profileFingerprint: resolved.profileFingerprint,
        templateId: resolved.style?.templateId ?? null,
        styleFingerprint: resolved.styleFingerprint,
      },
      resultReference: {
        profileId: resolved.profile.profileId,
        profileFingerprint: resolved.profileFingerprint,
        templateId: resolved.style?.templateId ?? null,
        styleFingerprint: resolved.styleFingerprint,
      },
      change: (document) =>
        applyCampaignStyleChange(document, resolved.style, true),
    });
  }

  async applyStyleSelected(
    scope: CampaignBrandActorScope,
    value: unknown,
  ): Promise<ApplyCampaignStyleResult> {
    assertCampaignActionWriteEnabled("apply_style");
    assertProgramWriteEnabled("brand_kit_projection");
    assertCampaignBrandApplicationAllowed(scope);
    const input = applyStyleSelectedSchema.parse(value);
    const resolved = await resolveMemberStyleSelection(scope, input);
    const clips = [...input.clips].sort((left, right) =>
      left.clipId.localeCompare(right.clipId),
    );
    return this.applySelectedEditorDocumentChange(scope, {
      action: "apply_style",
      clips,
      requestFingerprint: fingerprint({
        action: "apply_style",
        profileId: resolved.profileId,
        templateId: resolved.style.templateId,
        templateFingerprint: resolved.templateFingerprint,
        clips,
        retryOfId: scope.retryOfId ?? null,
      }),
      validatedOptions: {
        profileId: resolved.profileId,
        templateId: resolved.style.templateId,
        templateFingerprint: resolved.templateFingerprint,
      },
      resultReference: {
        profileId: resolved.profileId,
        templateId: resolved.style.templateId,
        templateFingerprint: resolved.templateFingerprint,
      },
      change: (document) =>
        applyCampaignStyleChange(document, resolved.style, false),
    });
  }

  async applySceneTemplate(
    scope: BrandActorScope & {
      projectId: string;
      idempotencyKey: string;
      retryOfId?: string;
    },
    profileId: string,
    templateId: string,
    value: unknown,
  ): Promise<ApplySceneTemplateResult> {
    assertCampaignActionWriteEnabled("apply_scene_template");
    assertProgramWriteEnabled("scene_templates");
    assertCampaignBrandApplicationAllowed(scope);
    const input = applySceneTemplateSchema.parse(value);
    const orderedClips = [...input.clips].sort((left, right) => left.clipId.localeCompare(right.clipId));
    const requestFingerprint = fingerprint({
      action: "apply_scene_template",
      profileId,
      templateId,
      templateFingerprint: input.templateFingerprint,
      placement: input.placement,
      clips: orderedClips,
      retryOfId: scope.retryOfId ?? null,
    });
    const prisma = requirePrisma();
    const replay = await prisma.campaignOperation.findUnique({
      where: { workspaceId_projectId_action_idempotencyKey: { workspaceId: scope.workspaceId, projectId: scope.projectId, action: "apply_scene_template", idempotencyKey: scope.idempotencyKey } },
      include: { items: { select: { requestedClipId: true, status: true } } },
    });
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new CampaignOperationError("campaign_operation_idempotency_conflict", "Idempotency key was reused with different input");
      }
      if (replay.status !== "running") {
        return { ...campaignOperationSnapshot(replay), replayed: true };
      }
    }
    if (!replay) {
      await assertCampaignEditorRetry({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        action: "apply_scene_template",
        retryOfId: scope.retryOfId,
        clips: orderedClips,
      });
    }
    const clips = await prisma.clip.findMany({
      where: {
        id: { in: orderedClips.map((clip) => clip.clipId) },
        projectId: scope.projectId,
        project: { workspaceId: scope.workspaceId },
      },
      select: { id: true },
    });
    const knownIds = new Set(clips.map((clip) => clip.id));
    let operation: CampaignOperationSnapshot | undefined = replay ?? undefined;
    if (!operation) try {
      operation = await prisma.campaignOperation.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          actorUserId: scope.actorUserId,
          action: "apply_scene_template",
          idempotencyKey: scope.idempotencyKey,
          requestFingerprint,
					validatedOptions: { profileId, templateId, templateFingerprint: input.templateFingerprint, placement: input.placement },
					pricingTier: scope.pricingTier,
          requestedCount: orderedClips.length,
          retryOfId: scope.retryOfId ?? null,
          items: {
            create: orderedClips.map((clip) => ({
              requestedClipId: clip.clipId,
              clipId: knownIds.has(clip.clipId) ? clip.clipId : null,
              expectedEditorRevision: clip.expectedEditorRevision,
              status: knownIds.has(clip.clipId) ? "pending" : "ineligible",
              errorCode: knownIds.has(clip.clipId) ? null : "campaign_clip_not_found",
              settledAt: knownIds.has(clip.clipId) ? null : new Date(),
            })),
          },
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      await throwIfCampaignRetryAlreadyExists(scope.retryOfId);
      const raced = await prisma.campaignOperation.findUnique({
        where: { workspaceId_projectId_action_idempotencyKey: { workspaceId: scope.workspaceId, projectId: scope.projectId, action: "apply_scene_template", idempotencyKey: scope.idempotencyKey } },
      });
      if (!raced || raced.requestFingerprint !== requestFingerprint) {
        throw new CampaignOperationError("campaign_operation_idempotency_conflict", "Idempotency key was reused with different input");
      }
      return this.applySceneTemplate(scope, profileId, templateId, value);
    }
    if (!operation) throw new CampaignOperationError("campaign_operation_admission_failed", "Campaign operation could not be admitted");

    const now = new Date();
    await prisma.campaignOperationItem.updateMany({
      where: { operationId: operation.id, status: "processing", leaseExpiresAt: { lte: now } },
      data: { status: "pending", claimToken: null, leaseExpiresAt: null },
    });
    for (const requested of boundedCampaignOperationItems(
      orderedClips.filter((clip) => knownIds.has(clip.clipId)),
    )) {
      const claimToken = randomUUID();
      const claimed = await prisma.campaignOperationItem.updateMany({
        where: { operationId: operation.id, requestedClipId: requested.clipId, status: "pending" },
        data: { status: "processing", claimToken, leaseExpiresAt: new Date(Date.now() + 10 * 60_000) },
      });
      if (claimed.count !== 1) continue;
      let status = "failed";
      let errorCode: string | null = "scene_template_apply_failed";
      let result: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
      try {
        const current = await clipEditorDocumentPersistence.readDocument({
          actorUserId: scope.actorUserId,
          workspaceId: scope.workspaceId,
          workspaceOwnerUserId: scope.workspaceOwnerUserId,
          projectId: scope.projectId,
          clipId: requested.clipId,
        });
        const sourceDuration = buildEditedTimeMap(current.document.deletedRanges, {
            startSec: current.document.clipStartSec,
            endSec: current.document.clipEndSec,
          }).editedDurationSec;
        const totalDurationSec = sourceDuration + current.document.sceneBlocks.reduce((total, scene) => total + scene.durationSec, 0);
        const existing = current.document.sceneBlocks.find((scene) =>
            scene.templateSnapshot?.fingerprint === input.templateFingerprint &&
            (input.placement === "start"
              ? Math.abs(scene.anchorSec) <= 0.001
              : Math.abs(scene.anchorSec + scene.durationSec - totalDurationSec) <= 0.001));
        if (current.revision !== requested.expectedEditorRevision) {
          status = "stale";
          errorCode = "campaign_clip_stale";
        } else if (existing) {
          status = "unchanged";
          errorCode = null;
          result = { editorRevision: current.revision, sceneBlockId: existing.id };
        } else {
          const anchorSec = input.placement === "start"
            ? 0
            : totalDurationSec;
          const scene = await sceneTemplateService.freezeForInsertion(scope, profileId, templateId, {
            id: randomUUID(),
            anchorSec,
          });
          if (scene.templateSnapshot?.fingerprint !== input.templateFingerprint) {
            status = "stale";
            errorCode = "scene_template_fingerprint_stale";
          } else {
            const next = applyEditorAction(current.document, { type: "insertSceneBlock", scene });
            if (next === current.document) {
              status = "ineligible";
              errorCode = "scene_template_document_limit";
            } else {
              const mutation = await clipEditorDocumentPersistence.mutateDocument({
                actorUserId: scope.actorUserId,
                workspaceId: scope.workspaceId,
                workspaceOwnerUserId: scope.workspaceOwnerUserId,
                projectId: scope.projectId,
                clipId: requested.clipId,
                intent: { kind: "replace", baseRevision: current.revision, document: next },
              });
              status = mutation.noop ? "unchanged" : "succeeded";
              errorCode = null;
              result = { editorRevision: mutation.revision, sceneBlockId: scene.id };
            }
          }
        }
      } catch (error) {
        if (error instanceof ClipEditorRevisionConflictError) {
          status = "stale";
          errorCode = "campaign_clip_stale";
        } else if (error instanceof SceneTemplateError && error.code === "scene_template_not_found") {
          status = "ineligible";
          errorCode = error.code;
        }
      }
      await prisma.campaignOperationItem.updateMany({
        where: { operationId: operation.id, requestedClipId: requested.clipId, status: "processing", claimToken },
        data: { status, errorCode, result, settledAt: new Date(), claimToken: null, leaseExpiresAt: null },
      });
    }

    const grouped = await prisma.campaignOperationItem.groupBy({
      by: ["status"],
      where: { operationId: operation.id },
      _count: { _all: true },
    });
    const count = (status: string) => grouped.find((entry) => entry.status === status)?._count._all ?? 0;
    if (count("pending") + count("processing") > 0) {
      const running = await prisma.campaignOperation.findUniqueOrThrow({ where: { id: operation.id } });
      return { ...campaignOperationSnapshot(running), replayed: replay !== null };
    }
    const counts = {
      succeeded: count("succeeded"),
      unchanged: count("unchanged"),
      stale: count("stale"),
      ineligible: count("ineligible"),
      failed: count("failed"),
    };
    const settled = await prisma.campaignOperation.update({
      where: { id: operation.id },
      data: {
				status: counts.stale + counts.ineligible + counts.failed > 0 ? "partial" : "completed",
        succeededCount: counts.succeeded,
        unchangedCount: counts.unchanged,
        staleCount: counts.stale,
        ineligibleCount: counts.ineligible,
        failedCount: counts.failed,
        completedAt: new Date(),
      },
    });
    return { ...campaignOperationSnapshot(settled), replayed: false };
  }

  async applyMotionSelected(
    scope: CampaignMotionActorScope,
    value: unknown,
  ): Promise<ApplyMotionSelectedResult> {
    assertCampaignActionWriteEnabled("apply_motion");
    if (
      !workspaceAllowsCapability(
        { role: scope.role, status: scope.status },
        "content.edit",
      )
    ) {
      throw new CampaignOperationError(
        "campaign_operation_forbidden",
        "Motion cannot be applied with this Workspace role",
      );
    }
    if (!hasFeature(scope.pricingTier, "campaign.operations")) {
      throw new CampaignOperationError(
        "campaign_operation_feature_unavailable",
        "Applying motion to selected clips requires Pro or Business",
      );
    }

    const input = applyMotionSelectedSchema.parse(value);
    const orderedClips = [...input.clips].sort((left, right) =>
      left.clipId.localeCompare(right.clipId),
    );
    const requestFingerprint = fingerprint({
      action: "apply_motion",
      change: input.change,
      clips: orderedClips,
      retryOfId: scope.retryOfId ?? null,
    });
    const prisma = requirePrisma();
    const replay = await prisma.campaignOperation.findUnique({
      where: {
        workspaceId_projectId_action_idempotencyKey: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          action: "apply_motion",
          idempotencyKey: scope.idempotencyKey,
        },
      },
    });
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new CampaignOperationError(
          "campaign_operation_idempotency_conflict",
          "Idempotency key was reused with different input",
        );
      }
      if (replay.status !== "running") {
        return { ...campaignOperationSnapshot(replay), replayed: true };
      }
    }
    if (!replay) {
      await assertCampaignEditorRetry({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        action: "apply_motion",
        retryOfId: scope.retryOfId,
        clips: orderedClips,
      });
    }

    const clips = await prisma.clip.findMany({
      where: {
        id: { in: orderedClips.map((clip) => clip.clipId) },
        projectId: scope.projectId,
        project: { workspaceId: scope.workspaceId },
      },
      select: { id: true },
    });
    const knownIds = new Set(clips.map((clip) => clip.id));
    let operation: CampaignOperationSnapshot | undefined = replay ?? undefined;
    if (!operation) {
      try {
        operation = await prisma.campaignOperation.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            actorUserId: scope.actorUserId,
            action: "apply_motion",
            idempotencyKey: scope.idempotencyKey,
            requestFingerprint,
            // This durable audit payload contains only the validated motion
            // vocabulary. It never captures clip text, titles, or asset URLs.
            validatedOptions: { change: input.change },
            pricingTier: scope.pricingTier,
            requestedCount: orderedClips.length,
            retryOfId: scope.retryOfId ?? null,
            items: {
              create: orderedClips.map((clip) => ({
                requestedClipId: clip.clipId,
                clipId: knownIds.has(clip.clipId) ? clip.clipId : null,
                expectedEditorRevision: clip.expectedEditorRevision,
                status: knownIds.has(clip.clipId) ? "pending" : "ineligible",
                errorCode: knownIds.has(clip.clipId)
                  ? null
                  : "campaign_clip_not_found",
                settledAt: knownIds.has(clip.clipId) ? null : new Date(),
              })),
            },
          },
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2002"
        ) {
          throw error;
        }
        await throwIfCampaignRetryAlreadyExists(scope.retryOfId);
        const raced = await prisma.campaignOperation.findUnique({
          where: {
            workspaceId_projectId_action_idempotencyKey: {
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              action: "apply_motion",
              idempotencyKey: scope.idempotencyKey,
            },
          },
        });
        if (!raced || raced.requestFingerprint !== requestFingerprint) {
          throw new CampaignOperationError(
            "campaign_operation_idempotency_conflict",
            "Idempotency key was reused with different input",
          );
        }
        return this.applyMotionSelected(scope, value);
      }
    }
    if (!operation) {
      throw new CampaignOperationError(
        "campaign_operation_admission_failed",
        "Campaign operation could not be admitted",
      );
    }

    await prisma.campaignOperationItem.updateMany({
      where: {
        operationId: operation.id,
        status: "processing",
        leaseExpiresAt: { lte: new Date() },
      },
      data: { status: "pending", claimToken: null, leaseExpiresAt: null },
    });
    for (const requested of boundedCampaignOperationItems(
      orderedClips.filter((clip) => knownIds.has(clip.clipId)),
    )) {
      const claimToken = randomUUID();
      const claimed = await prisma.campaignOperationItem.updateMany({
        where: {
          operationId: operation.id,
          requestedClipId: requested.clipId,
          status: "pending",
        },
        data: {
          status: "processing",
          claimToken,
          leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
      if (claimed.count !== 1) continue;

      let status = "failed";
      let errorCode: string | null = "campaign_motion_apply_failed";
      let result: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
      try {
        const current = await clipEditorDocumentPersistence.readDocument({
          actorUserId: scope.actorUserId,
          workspaceId: scope.workspaceId,
          workspaceOwnerUserId: scope.workspaceOwnerUserId,
          projectId: scope.projectId,
          clipId: requested.clipId,
        });
        const planned = applyCampaignMotionChange(current.document, input.change);
        if (current.revision !== requested.expectedEditorRevision) {
          status = "stale";
          errorCode = "campaign_clip_stale";
        } else if (planned.status === "unchanged") {
          status = "unchanged";
          errorCode = null;
          result = { editorRevision: current.revision };
        } else if (planned.status === "ineligible" || planned.status === "failed") {
          status = planned.status;
          errorCode = planned.code;
        } else {
          const mutation = await clipEditorDocumentPersistence.mutateDocument({
            actorUserId: scope.actorUserId,
            workspaceId: scope.workspaceId,
            workspaceOwnerUserId: scope.workspaceOwnerUserId,
            projectId: scope.projectId,
            clipId: requested.clipId,
            intent: {
              kind: "replace",
              baseRevision: current.revision,
              document: planned.document,
            },
          });
          status = mutation.noop ? "unchanged" : "succeeded";
          errorCode = null;
          result = { editorRevision: mutation.revision };
        }
      } catch (error) {
        if (error instanceof ClipEditorRevisionConflictError) {
          status = "stale";
          errorCode = "campaign_clip_stale";
        }
      }
      await prisma.campaignOperationItem.updateMany({
        where: {
          operationId: operation.id,
          requestedClipId: requested.clipId,
          status: "processing",
          claimToken,
        },
        data: {
          status,
          errorCode,
          result,
          settledAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        },
      });
    }

    const grouped = await prisma.campaignOperationItem.groupBy({
      by: ["status"],
      where: { operationId: operation.id },
      _count: { _all: true },
    });
    const count = (status: string) =>
      grouped.find((entry) => entry.status === status)?._count._all ?? 0;
    if (count("pending") + count("processing") > 0) {
      const running = await prisma.campaignOperation.findUniqueOrThrow({
        where: { id: operation.id },
      });
      return { ...campaignOperationSnapshot(running), replayed: replay !== null };
    }
    const counts = {
      succeeded: count("succeeded"),
      unchanged: count("unchanged"),
      stale: count("stale"),
      ineligible: count("ineligible"),
      failed: count("failed"),
    };
    const affected = counts.succeeded + counts.unchanged;
    const settled = await prisma.campaignOperation.update({
      where: { id: operation.id },
      data: {
        status:
          counts.stale + counts.ineligible + counts.failed === 0
            ? "completed"
            : affected === 0 && counts.failed > 0
              ? "failed"
              : "partial",
        succeededCount: counts.succeeded,
        unchangedCount: counts.unchanged,
        staleCount: counts.stale,
        ineligibleCount: counts.ineligible,
        failedCount: counts.failed,
        completedAt: new Date(),
      },
    });
    if (affected > 0) {
      const families =
        input.change.scope === "clip_transition"
          ? [`transition:${input.change.transition.type}`]
          : [input.change.motion.entrance, input.change.motion.exit]
              .filter((family) => family !== "none")
              .map((family) => `media:${family}`);
      const durationSec =
        input.change.scope === "clip_transition"
          ? input.change.transition.durationSec
          : input.change.motion.durationSec;
      await analyticsService
        .recordProjectEvent({
          projectId: scope.projectId,
          type: "motion_applied",
          metadata: {
            motionFamily: [...new Set(families)].sort(),
            durationBucket:
              durationSec <= 0.35
                ? "short"
                : durationSec <= 0.75
                  ? "standard"
                  : "long",
            targetCount: affected,
            applyScope: "selected",
            fallbackCode: ["none"],
          },
        })
        .catch((error) => {
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "motion_apply_analytics_record_failed",
              projectId: scope.projectId,
              campaignOperationId: settled.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
    }
    return { ...campaignOperationSnapshot(settled), replayed: false };
  }
}

export const campaignOperationService = new CampaignOperationService();
