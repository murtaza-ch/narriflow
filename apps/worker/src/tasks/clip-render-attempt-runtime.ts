import { createNativeRenderAdapters } from "../../../media/src/render-media-adapters";
import {
	createWriteStream as productionCreateWriteStream,
} from "node:fs";
import { pipeline as productionPipeline } from "node:stream/promises";
import { getPrismaClient } from "@narriflow/db/client";
import {
	analyticsService,
	audioAssetService as productionAudioAssetService,
	clipService as productionClipService,
	deleteObject as productionDeleteObject,
	downloadObjectToFile as productionDownloadObjectToFile,
	listObjectPageByPrefix,
	guardedFetch as productionGuardedFetch,
	getLayoutEvidenceLifecycle,
	presignDownloadUrl as productionPresignDownloadUrl,
	putFileFromPath as productionPutFileFromPath,
	WorkflowFailure,
	type MotionRenderAnalyticsMetadata,
	type RenderGroupAttemptRef,
	type WorkflowAttemptRef,
	type RenderGroupLifecycle,
} from "@narriflow/services";
import { asAttemptLost } from "../render-group-executor";
import type { RenderConfig } from "../../../media/src/render-config";
import { productionRenderDiagnosticAdapter } from "../../../media/src/render-diagnostic-adapter";
import {
	resolveBrollCutaways,
} from "./broll";
import {
	ClipRenderAttempt,
	type ClipRenderAttemptDependencies,
	type ClipRenderAttemptAdapters,
	type ClipRenderAttemptAdapterOverrides,
} from "../../../media/src/tasks/clip-render-attempt";

export interface ClipRenderAttemptRuntimeOptions
	extends Omit<ClipRenderAttemptDependencies, "adapters"> {
	/** The leased group this attempt renders; every durable write carries it. */
	group: RenderGroupAttemptRef;
	groups: Pick<
		RenderGroupLifecycle,
		| "markClipRenderVariantRendering"
		| "completeClipRenderVariant"
		| "failClipRenderVariant"
		| "writeLayoutEvidence"
	>;
	adapters?: ClipRenderAttemptAdapterOverrides & {
		remoteMedia?: Partial<RemoteMediaAdapter>;
	};
}

export function createClipRenderAttempt(
	input: ClipRenderAttemptRuntimeOptions,
): ClipRenderAttempt {
	return new ClipRenderAttempt({
		...input,
		adapters: (signal, withAttemptDiagnosticContext) =>
			createRuntimeAdapters(
				input.config,
				signal,
				withAttemptDiagnosticContext,
				input.group,
				input.groups,
				input.adapters,
			),
	});
}

function createRuntimeAdapters(
	config: Readonly<RenderConfig>,
	signal: AbortSignal,
	withAttemptDiagnosticContext: Parameters<
		ClipRenderAttemptDependencies["adapters"]
	>[1],
	group: RenderGroupAttemptRef,
	groups: ClipRenderAttemptRuntimeOptions["groups"],
	overrides?: ClipRenderAttemptRuntimeOptions["adapters"],
): ClipRenderAttemptAdapters {
	const writeDiagnostic = overrides?.diagnose ?? productionRenderDiagnosticAdapter.diagnose;
  const baseDiagnose: ClipRenderAttemptAdapters["diagnose"] = (event) => writeDiagnostic({ ...event, context: { ...event.context, groupId: group.groupId, groupToken: group.token, groupOwner: group.owner, workSetGeneration: group.workSetGeneration } });
	const diagnose = withAttemptDiagnosticContext(baseDiagnose);
 const native = createNativeRenderAdapters({ config, signal, diagnose, resolveBrollCutaways, overrides });
 function log(level: "info" | "error", message: string, context?: Record<string, unknown>) { try { diagnose({ level, message, context }); } catch { /* Diagnostics never decide settlement. */ } }
	// The engine's attempt id is the group token; every write below is fenced by
	// the group, and a lost group surfaces as the engine's ownership loss.
	const owned = <T,>(attempt: WorkflowAttemptRef, write: () => Promise<T>) =>
		asAttemptLost(attempt, write);
	const productionClipMutationAdapter: ClipRenderAttemptAdapters["clip"] = {
		markClipRenderVariantRendering: (attempt, clipRenderId) =>
			owned(attempt, () =>
				groups.markClipRenderVariantRendering(group, clipRenderId),
			),
		completeClipRenderVariant: async (attempt, clipRenderId, input) => {
			const persisted = await owned(attempt, () =>
				groups.completeClipRenderVariant(group, clipRenderId, input),
			);
			if (persisted) {
				await recordRenderAnalytics(
					clipRenderId,
					"completed",
					input.motionAnalytics,
				);
			}
			return { persisted };
		},
		failClipRenderVariant: async (
			attempt,
			clipRenderId,
			errorCode,
			disposition = "retryable",
			motionAnalytics,
		) => {
			const persisted = await owned(attempt, () =>
				groups.failClipRenderVariant(group, clipRenderId, errorCode, disposition),
			);
			if (persisted) {
				await recordRenderAnalytics(clipRenderId, "failed", motionAnalytics);
			}
		},
		completeClipAutoLayoutAnalysis: (attempt, clipId, analysis, expected) =>
			owned(attempt, () =>
				groups.writeLayoutEvidence(group, {
					clipId,
					field: "automatic",
					evidence: analysis as never,
					...expected,
				}),
			),
		completeClipSplitLayoutAnalysis: (attempt, clipId, analysis, expected) =>
			owned(attempt, () =>
				groups.writeLayoutEvidence(group, {
					clipId,
					field: "split",
					evidence: analysis as never,
					...expected,
				}),
			),
		completeClipSplitLayoutFailure: (attempt, clipId, failure, expected) =>
			owned(attempt, () =>
				groups.writeLayoutEvidence(group, {
					clipId,
					field: "split",
					evidence: failure as never,
					...expected,
				}),
			),
		setClipLayoutAnalysis: async (attempt, clipId, analysis, expected) => {
			await owned(attempt, () =>
				groups.writeLayoutEvidence(group, {
					clipId,
					field: "screen",
					evidence: analysis as never,
					...expected,
				}),
			);
		},
		setClipLayoutAnalysisFailure: async (
			attempt,
			clipId,
			failure,
			expected,
		) => {
			await owned(attempt, () =>
				groups.writeLayoutEvidence(group, {
					clipId,
					field: "screen",
					evidence: failure as never,
					...expected,
				}),
			);
		},
	};

	async function recordRenderAnalytics(
		clipRenderId: string,
		outcome: "completed" | "failed",
		motionAnalytics?: MotionRenderAnalyticsMetadata,
	) {
		try {
			const prisma = getPrismaClient();
			if (!prisma) return;
			const render = await prisma.clipRender.findUnique({
				where: { id: clipRenderId },
				select: {
					aspectRatio: true,
 createdAt: true,
 startedAt: true,
 completedAt: true,
					clipId: true,
					clip: { select: { projectId: true } },
				},
			});
			if (!render) return;
      if (outcome === "completed" && render.completedAt) diagnose({ level: "info", message: "clip_render_delivery_latency", context: { clipRenderId, clipId: render.clipId, projectId: render.clip.projectId, requestToReadyMs: render.completedAt.getTime() - render.createdAt.getTime(), queueAgeMs: render.startedAt ? render.startedAt.getTime() - render.createdAt.getTime() : null } });
			const events: Array<() => Promise<unknown>> = [];
			if (outcome === "completed") {
				events.push(() =>
					analyticsService.recordProjectEvent({
						projectId: render.clip.projectId,
						clipId: render.clipId,
						type: "render_completed",
						metadata: { aspectRatio: render.aspectRatio },
					}),
				);
			}
			if (motionAnalytics && motionAnalytics.targetCount > 0) {
				events.push(() =>
					analyticsService.recordProjectEvent({
						projectId: render.clip.projectId,
						clipId: render.clipId,
						type: "motion_render_outcome",
						metadata: {
							aspectRatio: render.aspectRatio,
							...motionAnalytics,
							renderOutcome: outcome,
						},
					}),
				);
			}
			await Promise.all(events.map(async (record) => record()));
		} catch {
			// Lookup, enqueue and diagnostics are all outside durable settlement.
			log("error", "render_analytics_record_failed", {
				clipRenderId,
				phase: "diagnostics",
				operation: "record_render_analytics",
				outcome,
			});
		}
	}

 const defaults: ClipRenderAttemptAdapters = {
 ...native, state: productionClipService,
 layoutEvidence: { readCompatibleDurable: (clipId, frozen) => getLayoutEvidenceLifecycle().readCompatibleDurable(clipId, frozen) },
 clip: productionClipMutationAdapter, audioAsset: productionAudioAssetService, assets: { loadSceneSources },
 storage: { deleteObject: productionDeleteObject, downloadObjectToFile: productionDownloadObjectToFile,
 sourceSizeBytes: async (key, signal) => { const page = await listObjectPageByPrefix(key, 1, undefined, { signal }); const object = page.objects.find((object) => object.key === key); if (!object) throw new WorkflowFailure("source_object_missing", "permanent", "Required source object is missing"); return object.sizeBytes; },
 presignDownloadUrl: productionPresignDownloadUrl, putFileFromPath: productionPutFileFromPath },
 };
 return { ...defaults, ...overrides, ...native, clip: { ...defaults.clip, ...overrides?.clip }, storage: { ...defaults.storage, ...overrides?.storage } };
}

async function loadSceneSources(input: {
	workspaceId: string;
	visualIds: readonly string[];
	fontIds: readonly string[];
}) {
	const prisma = getPrismaClient();
	if (!prisma)
		throw new WorkflowFailure(
			"scene_asset_database_unavailable", "retryable",
			"Scene assets cannot be resolved",
		);
	const workspace = await prisma.workspace.findUnique({
		where: { id: input.workspaceId },
		select: { personalOwnerUserId: true },
	});
	if (!workspace)
		throw new WorkflowFailure(
			"scene_asset_workspace_unavailable", "retryable",
			"Scene asset ownership could not be loaded",
		);
	// Branding ownership follows the Workspace kind, never its plan.
	const ownerWhere = workspace.personalOwnerUserId
		? { userId: workspace.personalOwnerUserId, workspaceId: null }
		: { workspaceId: input.workspaceId };
	const [visuals, fonts] = await Promise.all([
		input.visualIds.length
			? prisma.visualAsset.findMany({
					where: { id: { in: [...input.visualIds] }, ...ownerWhere },
					select: { id: true, kind: true, fingerprint: true, storageKey: true },
				})
			: [],
		input.fontIds.length
			? prisma.brandFont.findMany({
					where: { id: { in: [...input.fontIds] }, ...ownerWhere },
					select: {
						id: true,
						family: true,
						fingerprint: true,
						storageKey: true,
						format: true,
					},
				})
			: [],
	]);
	return { visuals, fonts };
}

interface RemoteMediaAdapter {
	createWriteStream: typeof productionCreateWriteStream;
	guardedFetch: typeof productionGuardedFetch;
	pipeline: typeof productionPipeline;
}
