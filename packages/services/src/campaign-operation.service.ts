import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  clipAspectRatioFromDb,
  applyEditorAction,
  applySceneTemplateSchema,
  buildEditedTimeMap,
  createExportBundleSchema,
  exportBundleManifestSchema,
  type ClipAspectRatio,
  type ClipRenderResolution,
  type PricingTier,
  type ExportBundleManifest,
} from "@narriflow/validators";
import { assertBrandApplicationAllowed, type BrandActorScope } from "./brand-ownership";
import {
  clipEditorDocumentPersistence,
  ClipEditorRevisionConflictError,
} from "./clip-editor-document-persistence";
import { hasFeature } from "./plan-features";
import { assertProgramWriteEnabled, isProgramWriteEnabled } from "./program-rollout";
import { presignDownloadUrl } from "./r2-storage";
import { sceneTemplateService, SceneTemplateError } from "./scene-template.service";
import { getWorkflowRunLifecycle } from "./workflow-run-lifecycle";

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
    if (!isProgramWriteEnabled("campaign_operations")) {
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

  async getExportBundleDownload(scope: { workspaceId: string; projectId: string }, bundleId: string) {
    const bundle = await requirePrisma().exportBundle.findFirst({
      where: { id: bundleId, operation: { workspaceId: scope.workspaceId, projectId: scope.projectId } },
      select: { status: true, storageKey: true, expiresAt: true },
    });
    if (!bundle) throw new CampaignOperationError("export_bundle_not_found", "Export bundle was not found");
    if (bundle.expiresAt && bundle.expiresAt <= new Date()) throw new CampaignOperationError("export_bundle_expired", "Export bundle has expired");
    if (bundle.status !== "completed" || !bundle.storageKey) throw new CampaignOperationError("export_bundle_not_ready", "Export bundle is not ready for download");
    return presignDownloadUrl({ key: bundle.storageKey, expiresIn: 60, fileName: `narriflow-export-${bundleId}.zip` });
  }

  async retryExportBundle(scope: { actorUserId: string; workspaceId: string; projectId: string; pricingTier: PricingTier; idempotencyKey: string }, bundleId: string) {
		const bundle = await requirePrisma().exportBundle.findFirst({
      where: { id: bundleId, operation: { workspaceId: scope.workspaceId, projectId: scope.projectId, action: "export_bundle" } },
			select: { operationId: true },
    });
		if (!bundle) throw new CampaignOperationError("export_bundle_not_found", "Export bundle was not found");
		return this.retryExportBundleOperation(scope, bundle.operationId);
	}

	async retryExportBundleOperation(scope: { actorUserId: string; workspaceId: string; projectId: string; pricingTier: PricingTier; idempotencyKey: string }, operationId: string) {
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

  async createExportBundle(scope: { actorUserId: string; workspaceId: string; projectId: string; pricingTier: PricingTier; idempotencyKey: string; retryOfId?: string }, value: unknown): Promise<{ operationId: string; workflowRunId: string; manifest: ExportBundleManifest; replayed: boolean }> {
    assertProgramWriteEnabled("campaign_operations");
    if (!hasFeature(scope.pricingTier, "export.bundles")) throw new CampaignOperationError("export_bundle_feature_unavailable", "Export bundles are not available on this plan");
    const input = createExportBundleSchema.parse(value);
    const expiresAt = new Date(Date.now() + exportBundleRetentionMs());
    if (new Set(input.clips.map((clip) => clip.clipId)).size !== input.clips.length) {
      throw new CampaignOperationError("export_bundle_duplicate_clip", "A clip can appear only once in an export bundle");
    }
    const requestFingerprint = fingerprint({ action: "export_bundle", ...input });
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
    const clips = await prisma.clip.findMany({
      where: { projectId: scope.projectId, id: { in: input.clips.map((clip) => clip.clipId) }, project: { workspaceId: scope.workspaceId } },
      select: { id: true, title: true, editorRevision: true, exports: { where: { status: "ready", resolution: input.resolution }, orderBy: { createdAt: "desc" }, take: 1, include: { variants: { where: { status: "completed", storageKey: { not: null }, sizeBytes: { gt: 0 } } } } } },
    });
    const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
    const eligible = input.clips.flatMap((expected) => {
      const clip = clipsById.get(expected.clipId);
      if (!clip) return [];
      const frozen = clip.exports[0];
      if (clip.editorRevision !== expected.expectedEditorRevision || !frozen || frozen.editorRevision !== expected.expectedEditorRevision) return [];
      const variants = frozen.variants
        .filter((variant) => input.aspectRatios.includes(clipAspectRatioFromDb[variant.aspectRatio]))
        .sort((a, b) => input.aspectRatios.indexOf(clipAspectRatioFromDb[a.aspectRatio]) - input.aspectRatios.indexOf(clipAspectRatioFromDb[b.aspectRatio]));
      return variants.length ? [{ clip, frozen, variants }] : [];
    });
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
          const code = !known ? "campaign_clip_not_found" : known.editorRevision !== item.expectedEditorRevision ? "campaign_clip_stale" : "export_variant_unavailable";
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
    const excluded = input.clips.filter((item) => !includedIds.has(item.clipId)).map((item) => ({ clipId: item.clipId, code: !clips.some((clip) => clip.id === item.clipId) ? "campaign_clip_not_found" : clips.find((clip) => clip.id === item.clipId)?.editorRevision !== item.expectedEditorRevision ? "campaign_clip_stale" : "export_variant_unavailable" }));
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

  async applySceneTemplate(
    scope: BrandActorScope & { projectId: string; idempotencyKey: string },
    profileId: string,
    templateId: string,
    value: unknown,
  ): Promise<ApplySceneTemplateResult> {
    assertProgramWriteEnabled("campaign_operations");
    assertProgramWriteEnabled("scene_templates");
    if (!hasFeature(scope.pricingTier as PricingTier, "campaign.operations")) {
      throw new CampaignOperationError("campaign_operation_feature_unavailable", "Campaign operations are not available on this plan");
    }
    assertBrandApplicationAllowed(scope);
    const input = applySceneTemplateSchema.parse(value);
    const orderedClips = [...input.clips].sort((left, right) => left.clipId.localeCompare(right.clipId));
    const requestFingerprint = fingerprint({
      action: "apply_scene_template",
      profileId,
      templateId,
      templateFingerprint: input.templateFingerprint,
      placement: input.placement,
      clips: orderedClips,
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
    for (const requested of orderedClips.filter((clip) => knownIds.has(clip.clipId))) {
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
        if (existing) {
          status = "unchanged";
          errorCode = null;
          result = { editorRevision: current.revision, sceneBlockId: existing.id };
        } else if (current.revision !== requested.expectedEditorRevision) {
          status = "stale";
          errorCode = "campaign_clip_stale";
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
              status = "failed";
              errorCode = "scene_template_document_limit";
            } else {
              const mutation = await clipEditorDocumentPersistence.mutateDocument({
                actorUserId: scope.actorUserId,
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
}

export const campaignOperationService = new CampaignOperationService();
