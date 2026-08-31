import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	brollCuesArraySchema,
	brollPlacementSchema,
	sceneBlockSchema,
	transcriptUtteranceSchema,
} from "@narriflow/validators";

import { brandOwnerWhere } from "./brand-ownership";
import {
	GeneratedMediaStudioError,
	type GeneratedMediaStudioLibrary,
} from "./generated-media-studio";
import { withSerializableTransaction } from "./serializable-transaction";
import { headObject, presignDownloadUrl } from "./r2-storage";

type FrozenAssetObjectResolution =
	| { state: "available"; accessUrl: string }
	| { state: "missing" | "storage_unavailable" };

interface FrozenAssetObjectAccess {
	resolve(key: string, fileName?: string): Promise<FrozenAssetObjectResolution>;
}

function isMissingObject(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as {
		name?: unknown;
		code?: unknown;
		Code?: unknown;
		statusCode?: unknown;
		$metadata?: { httpStatusCode?: unknown };
	};
	return (
		[candidate.name, candidate.code, candidate.Code].some((value) =>
			["NoSuchKey", "NotFound"].includes(String(value)),
		) ||
		candidate.statusCode === 404 ||
		candidate.$metadata?.httpStatusCode === 404
	);
}

const productionFrozenAssetObjectAccess: FrozenAssetObjectAccess = {
	async resolve(key, fileName) {
		try {
			await headObject(key);
		} catch (error) {
			return {
				state: isMissingObject(error) ? "missing" : "storage_unavailable",
			};
		}
		try {
			return {
				state: "available",
				accessUrl: await presignDownloadUrl({ key, fileName }),
			};
		} catch {
			return { state: "storage_unavailable" };
		}
	},
};

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function generatedMediaDownloadFileName(input: {
	title: string;
	kind: "image" | "video";
	contentType: string;
}) {
	const extension = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
		"video/mp4": "mp4",
		"video/quicktime": "mov",
	}[input.contentType] ?? (input.kind === "image" ? "png" : "mp4");
	return `${input.title}.${extension}`;
}

type JobBoundReusableAsset = {
	ownerUserId: string | null;
	ownerWorkspaceId: string | null;
	stagedFingerprint: string | null;
	resultAssetId: string | null;
	resultAsset: {
		id: string;
		userId: string | null;
		workspaceId: string | null;
		fingerprint: string;
		provenance: "uploaded" | "generated" | "extracted";
	} | null;
};

function isExactReusableResult(
	job: JobBoundReusableAsset,
): job is JobBoundReusableAsset & { resultAsset: NonNullable<JobBoundReusableAsset["resultAsset"]> } {
	const asset = job.resultAsset;
	return Boolean(
		asset &&
			job.resultAssetId === asset.id &&
			job.stagedFingerprint !== null &&
			job.stagedFingerprint === asset.fingerprint &&
			job.ownerUserId === asset.userId &&
			job.ownerWorkspaceId === asset.workspaceId &&
			(asset.provenance === "uploaded" || asset.provenance === "generated"),
	);
}

export function createPrismaGeneratedMediaStudioLibrary(
	prisma?: PrismaClient,
	objectAccess: FrozenAssetObjectAccess = productionFrozenAssetObjectAccess,
): GeneratedMediaStudioLibrary {
	return {
		async getActiveBrandProfile(scope, projectId) {
			const client = prisma ?? requirePrisma();
			const project = await client.project.findFirst({
				where: { id: projectId, workspaceId: scope.workspaceId },
				select: {
					brandProfile: {
						select: { id: true, name: true, deletedAt: true },
					},
				},
			});
			return project?.brandProfile && project.brandProfile.deletedAt === null
				? { id: project.brandProfile.id, name: project.brandProfile.name }
				: null;
		},

		async resolveJobAssets(input) {
			if (input.jobs.length === 0) return [];
			const client = prisma ?? requirePrisma();
			const rows = await client.generatedMediaJob.findMany({
				where: {
					id: { in: input.jobs.map((job) => job.jobId) },
					workspaceId: input.scope.workspaceId,
					projectId: input.projectId,
				},
				select: {
					id: true,
					ownerUserId: true,
					ownerWorkspaceId: true,
					stagedFingerprint: true,
					resultAssetId: true,
					resultAsset: {
						select: {
							id: true,
							userId: true,
							workspaceId: true,
							title: true,
							kind: true,
							fingerprint: true,
							provenance: true,
							durationSec: true,
							storageKey: true,
							deletedAt: true,
							profiles: { select: { profileId: true } },
						},
					},
				},
			});
			const byJobId = new Map(rows.map((row) => [row.id, row]));
			return Promise.all(input.jobs.map(async (candidate) => {
				const row = byJobId.get(candidate.jobId);
				const asset = row?.resultAsset;
				if (
					!row ||
					!candidate.resultAssetId ||
					row.resultAssetId !== candidate.resultAssetId ||
					!isExactReusableResult(row) ||
					asset?.id !== candidate.resultAssetId ||
					asset.kind !== candidate.kind
				) {
					return {
						jobId: candidate.jobId,
						state: "missing" as const,
						savedToActiveBrandProfile: false,
						asset: null,
					};
				}
				const savedToActiveBrandProfile = Boolean(
					input.activeBrandProfileId &&
						asset.profiles.some(
							(membership) =>
								membership.profileId === input.activeBrandProfileId,
						),
				);
				if (asset.deletedAt) {
					return {
						jobId: candidate.jobId,
						state: "deleted" as const,
						savedToActiveBrandProfile,
						asset: null,
					};
				}
				const object = await objectAccess.resolve(asset.storageKey);
				if (object.state !== "available") {
					return {
						jobId: candidate.jobId,
						state: object.state,
						savedToActiveBrandProfile,
						asset: null,
					};
				}
				return {
					jobId: candidate.jobId,
					state: "available" as const,
					savedToActiveBrandProfile,
					asset: {
						id: asset.id,
						title: asset.title,
						kind: asset.kind,
						fingerprint: asset.fingerprint,
						provenance: asset.provenance,
						durationSec: asset.durationSec,
						accessUrl: object.accessUrl,
					},
				};
			}));
		},

		async resolveJobDownload(input) {
			const client = prisma ?? requirePrisma();
			const job = await client.generatedMediaJob.findFirst({
				where: {
					id: input.jobId,
					workspaceId: input.scope.workspaceId,
					projectId: input.projectId,
					status: "completed",
					resultAssetId: input.resultAssetId,
				},
				select: {
					ownerUserId: true,
					ownerWorkspaceId: true,
					stagedFingerprint: true,
					resultAssetId: true,
					resultAsset: {
						select: {
							id: true,
							userId: true,
							workspaceId: true,
							title: true,
							kind: true,
							contentType: true,
							storageKey: true,
							fingerprint: true,
							provenance: true,
							deletedAt: true,
						},
					},
				},
			});
			const asset = job?.resultAsset;
			if (
				!job ||
				!isExactReusableResult(job) ||
				!asset ||
				asset.id !== input.resultAssetId ||
				asset.kind !== input.kind ||
				asset.deletedAt
			) {
				return null;
			}
			const object = await objectAccess.resolve(
				asset.storageKey,
				generatedMediaDownloadFileName({
					title: asset.title,
					kind: asset.kind,
					contentType: asset.contentType,
				}),
			);
			return object.state === "available"
				? { accessUrl: object.accessUrl }
				: null;
		},

		async resolvePromptContext(input) {
			if (input.clipId === null) {
				if (input.promptOrigin.kind === "manual") return null;
				throw new GeneratedMediaStudioError(
					"generated_media_prompt_source_invalid",
				);
			}
			const client = prisma ?? requirePrisma();
			const clip = await client.clip.findFirst({
				where: {
					id: input.clipId,
					projectId: input.projectId,
					project: { workspaceId: input.scope.workspaceId },
				},
				select: { editorRevision: true, transcriptSlice: true, brollCues: true },
			});
			if (!clip) {
				throw new GeneratedMediaStudioError(
					"generated_media_prompt_source_invalid",
				);
			}
			if (input.promptOrigin.kind === "manual") return null;
			if (
				input.sourceRevision !== undefined &&
				input.sourceRevision !== null &&
				clip.editorRevision !== input.sourceRevision
			) {
				throw new GeneratedMediaStudioError(
					"generated_media_prompt_source_revision_conflict",
					clip.editorRevision,
				);
			}

			const fail = () => {
				throw new GeneratedMediaStudioError(
					"generated_media_prompt_source_invalid",
				);
			};
			let contextParts: string[];
			if (input.promptOrigin.kind === "transcript_selection") {
				const transcript = transcriptUtteranceSchema.array().safeParse(
					clip.transcriptSlice,
				);
				if (!transcript.success) return fail();
				const prefix = `clip:${input.clipId}:transcript:`;
				contextParts = input.promptOrigin.sourceIds.map((sourceId) => {
					const [utteranceIndexText, wordIndexText, ...rest] = sourceId
						.slice(prefix.length)
						.split(":");
					const utteranceIndex = Number(utteranceIndexText);
					const wordIndex = Number(wordIndexText);
					if (
						!sourceId.startsWith(prefix) ||
						rest.length > 0 ||
						!Number.isSafeInteger(utteranceIndex) ||
						!Number.isSafeInteger(wordIndex) ||
						utteranceIndex < 0 ||
						wordIndex < 0
					) return fail();
					const utterance = transcript.data.find(
						(candidate) => candidate.index === utteranceIndex,
					);
					const word = utterance?.words[wordIndex]?.word.trim();
					return word || fail();
				});
			} else {
				const cues = brollCuesArraySchema.safeParse(clip.brollCues ?? []);
				if (!cues.success) return fail();
				const prefix = `clip:${input.clipId}:broll:`;
				contextParts = input.promptOrigin.sourceIds.map((sourceId) => {
					const index = Number(sourceId.slice(prefix.length));
					if (
						!sourceId.startsWith(prefix) ||
						!Number.isSafeInteger(index) ||
						index < 0
					) return fail();
					const cue = cues.data[index];
					if (!cue) return fail();
					return cue.reason?.trim()
						? `${cue.query}. ${cue.reason.trim()}`
						: cue.query;
				});
			}
			if (!input.includeDerivedContext) return null;
			const context = contextParts.join(" ").trim().slice(0, 4_000);
			return context || fail();
		},

		async resolveFrozenBrollAsset(input) {
			const client = prisma ?? requirePrisma();
			const clip = await client.clip.findFirst({
				where: {
					id: input.clipId,
					projectId: input.projectId,
					project: { workspaceId: input.scope.workspaceId },
				},
				select: { brollPlacements: true, sceneBlocks: true },
			});
			if (!clip) return null;
			const placements = brollPlacementSchema.array().safeParse(
				clip.brollPlacements,
			);
			if (!placements.success) {
				throw new Error("Clip B-roll placements are invalid");
			}
			const scenes = sceneBlockSchema.array().safeParse(clip.sceneBlocks ?? []);
			if (!scenes.success) {
				throw new Error("Clip Scene Blocks are invalid");
			}
			const referencedByBroll = placements.data.some(
				(placement) =>
					placement.asset.id === input.assetId &&
					placement.asset.fingerprint === input.fingerprint &&
					placement.mediaKind === input.mediaKind,
			);
			const referencedByScene = scenes.data.some(
				(scene) =>
					(scene.content.kind === "image" || scene.content.kind === "video") &&
					scene.content.asset.id === input.assetId &&
					scene.content.asset.fingerprint === input.fingerprint &&
					scene.content.kind === input.mediaKind,
			);
			if (!referencedByBroll && !referencedByScene) return null;

			const asset = await client.visualAsset.findFirst({
				where: {
					id: input.assetId,
					...brandOwnerWhere(input.scope),
				},
				select: {
					id: true,
					fingerprint: true,
					kind: true,
					storageKey: true,
					deletedAt: true,
				},
			});
			const base = {
				assetId: input.assetId,
				fingerprint: input.fingerprint,
				mediaKind: input.mediaKind,
			};
			if (!asset) {
				return { ...base, state: "missing" as const, accessUrl: null };
			}
			if (
				asset.fingerprint !== input.fingerprint ||
				asset.kind !== input.mediaKind
			) {
				return {
					...base,
					state: "fingerprint_stale" as const,
					accessUrl: null,
				};
			}
			const object = await objectAccess.resolve(asset.storageKey);
			if (object.state !== "available") {
				return { ...base, state: object.state, accessUrl: null };
			}
			return {
				...base,
				state: asset.deletedAt ? ("deleted" as const) : ("available" as const),
				accessUrl: object.accessUrl,
			};
		},

		async softDeleteUnreferenced(input) {
			const client = prisma ?? requirePrisma();
			return withSerializableTransaction(client, async (tx) => {
				const job = await tx.generatedMediaJob.findFirst({
					where: {
						id: input.jobId,
						workspaceId: input.scope.workspaceId,
						projectId: input.projectId,
						status: "completed",
						resultAssetId: { not: null },
					},
					select: {
						ownerUserId: true,
						ownerWorkspaceId: true,
						stagedFingerprint: true,
						resultAssetId: true,
						resultAsset: {
							select: {
								id: true,
								userId: true,
								workspaceId: true,
								fingerprint: true,
								provenance: true,
								deletedAt: true,
								profiles: { select: { id: true }, take: 1 },
								sceneTemplates: {
									where: { deletedAt: null },
									select: { id: true },
									take: 1,
								},
								socialPostThumbnails: { select: { id: true }, take: 1 },
							},
						},
					},
				});
				const asset = job?.resultAsset;
				if (!job || !isExactReusableResult(job) || !asset) {
					return null;
				}
				// An uploaded collision remains the user's original library asset.
				// The generated job may use it, but it never owns its deletion.
				if (asset.provenance === "uploaded") {
					throw new GeneratedMediaStudioError("generated_media_asset_in_use");
				}
				if (asset.deletedAt) {
					return { assetId: asset.id, deleted: true as const };
				}
				if (
					asset.profiles.length > 0 ||
					asset.sceneTemplates.length > 0 ||
					asset.socialPostThumbnails.length > 0
				) {
					throw new GeneratedMediaStudioError("generated_media_asset_in_use");
				}
				const deleted = await tx.visualAsset.updateMany({
					where: { id: asset.id, deletedAt: null },
					data: { deletedAt: new Date() },
				});
				return deleted.count === 1
					? { assetId: asset.id, deleted: true as const }
					: null;
			});
		},
	};
}
