import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	editorDocumentSchema,
	generatedMediaAnalyticsEventSchema,
	resolvePricingTier,
} from "@narriflow/validators";

import {
	ClipEditorRevisionConflictError,
	mutatePrismaClipEditorDocumentInTransaction,
} from "./clip-editor-document-persistence";
import {
	GeneratedMediaInsertionError,
	type GeneratedMediaInsertionResult,
	type GeneratedMediaInsertionSnapshot,
	type GeneratedMediaInsertionStore,
} from "./generated-media-insertion";
import { withSerializableTransaction } from "./serializable-transaction";
import { generatedMediaLatencyBucket } from "./generated-media-analytics";

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
	return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isUniqueConstraintError(error: unknown) {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
	);
}

export function generatedMediaInsertionAnalyticsEventId(
	workspaceId: string,
	idempotencyKey: string,
) {
	const bytes = createHash("sha256")
		.update(`generated-media-insertion:${workspaceId}:${idempotencyKey}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readReplay(
	prisma: PrismaClient,
	input: {
		workspaceId: string;
		idempotencyKey: string;
		requestFingerprint: string;
	},
): Promise<
	| (GeneratedMediaInsertionResult & {
			job: { id: string; workspaceId: string; projectId: string; clipId: string | null };
	  })
	| null
> {
	const command = await prisma.generatedMediaInsertion.findUnique({
		where: {
			workspaceId_idempotencyKey: {
				workspaceId: input.workspaceId,
				idempotencyKey: input.idempotencyKey,
			},
		},
		select: {
			requestFingerprint: true,
			kind: true,
			targetId: true,
			editorRevision: true,
			documentSnapshot: true,
			assetId: true,
			assetFingerprint: true,
			assetProvenance: true,
			asset: { select: { kind: true } },
			job: {
				select: { id: true, workspaceId: true, projectId: true, clipId: true },
			},
		},
	});
	if (!command) return null;
	if (command.requestFingerprint !== input.requestFingerprint) {
		throw new GeneratedMediaInsertionError(
			"generated_media_insertion_idempotency_conflict",
		);
	}
	const document = editorDocumentSchema.parse(command.documentSnapshot);
	if (command.kind !== "broll" && command.kind !== "scene_block") {
		throw new GeneratedMediaInsertionError("generated_media_insertion_invalid");
	}
	return {
		revision: command.editorRevision,
		document,
		kind: command.kind,
		targetId: command.targetId,
		asset: {
			id: command.assetId,
			fingerprint: command.assetFingerprint,
			provenance: command.assetProvenance,
			kind: command.asset.kind,
		},
		replayed: true,
		job: command.job,
	};
}

export function createPrismaGeneratedMediaInsertionStore(
	prisma?: PrismaClient,
): GeneratedMediaInsertionStore {
	return {
		analyticsDelivery: "transactional",
		async execute(input) {
			const client = prisma ?? requirePrisma();
			const replay = await readReplay(client, {
				workspaceId: input.scope.workspaceId,
				idempotencyKey: input.request.idempotencyKey,
				requestFingerprint: input.requestFingerprint,
			});
			if (replay) return replay;
			try {
				return await withSerializableTransaction(client, async (tx) => {
					const racedReplay = await readReplay(tx as PrismaClient, {
						workspaceId: input.scope.workspaceId,
						idempotencyKey: input.request.idempotencyKey,
						requestFingerprint: input.requestFingerprint,
					});
					if (racedReplay) return racedReplay;

					const job = await tx.generatedMediaJob.findFirst({
						where: {
							id: input.request.jobId,
							workspaceId: input.scope.workspaceId,
							projectId: input.request.projectId,
						},
						include: { resultAsset: true, usage: true },
					});
					if (!job || !job.resultAsset) return null;
					const resultAsset = job.resultAsset;
					const companion = await mutatePrismaClipEditorDocumentInTransaction(
						tx,
						{
							scope: {
								actorUserId: input.scope.workspaceOwnerUserId,
								projectId: input.request.projectId,
								clipId: input.request.clipId,
							},
							expectedRevision: input.request.baseRevision,
							plan: (clip) => {
								const plan = input.plan({
									job: {
										id: job.id,
										workspaceId: job.workspaceId,
										projectId: job.projectId,
										clipId: job.clipId,
										ownerUserId: job.ownerUserId,
										ownerWorkspaceId: job.ownerWorkspaceId,
										kind: job.kind as "image" | "video",
										status:
											job.status as GeneratedMediaInsertionSnapshot["job"]["status"],
										resultAssetId: job.resultAssetId,
										resultFingerprint: job.stagedFingerprint,
										insertionCount: job.insertionCount,
										lastInsertionKind:
											job.lastInsertionKind as "broll" | "scene_block" | null,
										lastInsertedAt: job.lastInsertedAt,
									},
									asset: {
										id: resultAsset.id,
										userId: resultAsset.userId,
										workspaceId: resultAsset.workspaceId,
										kind: resultAsset.kind,
										fingerprint: resultAsset.fingerprint,
										provenance: resultAsset.provenance,
										durationSec: resultAsset.durationSec,
										deletedAt: resultAsset.deletedAt,
									},
									clip: {
										id: clip.clipId,
										projectId: clip.projectId,
										workspaceId: input.scope.workspaceId,
										revision: clip.revision,
										document: clip.document,
										original: clip.original,
										mutableRenders: clip.mutableRenders,
									},
								});
								return { nextDocument: plan.nextDocument, value: plan };
							},
						},
					);
					if (!companion) return null;
					if (companion.mutation.noop) {
						throw new GeneratedMediaInsertionError("generated_media_insertion_invalid");
					}
					const plan = companion.value;
					await tx.generatedMediaJob.update({
						where: { id: job.id },
						data: {
							insertionCount: { increment: 1 },
							lastInsertionKind: plan.kind,
							lastInsertedAt: input.now,
							updatedAt: input.now,
						},
					});
					const revision = companion.mutation.revision;
					await tx.generatedMediaInsertion.create({
						data: {
							workspaceId: input.scope.workspaceId,
							projectId: input.request.projectId,
							clipId: input.request.clipId,
							jobId: job.id,
							actorUserId: input.scope.actorUserId,
							assetId: resultAsset.id,
							assetFingerprint: resultAsset.fingerprint,
							assetProvenance: resultAsset.provenance,
							idempotencyKey: input.request.idempotencyKey,
							requestFingerprint: input.requestFingerprint,
							kind: plan.kind,
							targetId: plan.targetId,
							editorRevision: revision,
							documentSnapshot: toPrismaJson(companion.mutation.document),
							createdAt: input.now,
						},
					});
					// A successful command is the first durable insertion-attempt boundary.
					// Validation and revision failures roll back without inventing an
					// analytics attempt that the command table cannot represent.
					const analytics = generatedMediaAnalyticsEventSchema.parse({
						type: "generated_asset_inserted",
						projectId: input.request.projectId,
						clipId: input.request.clipId,
						metadata: {
							kind: job.kind,
							providerAlias: job.provider,
							modelAlias: job.model,
							status: "completed",
							latencyBucket: generatedMediaLatencyBucket(
								Math.max(0, input.now.getTime() - job.createdAt.getTime()),
							),
							retryCount: Math.max(0, job.attemptCount - 1),
							moderationOutcome: job.moderationOutcome,
							usageUnits:
								job.usage?.status === "finalized"
									? job.usage.finalizedUnits
									: (job.usage?.reservedUnits ?? 0),
							insertionAction: plan.kind,
							outcome: "succeeded",
							planTier: resolvePricingTier(input.scope.pricingTier),
						},
					});
					await tx.projectAnalyticsEvent.create({
						data: {
							id: generatedMediaInsertionAnalyticsEventId(
								input.scope.workspaceId,
								input.request.idempotencyKey,
							),
							projectId: analytics.projectId,
							clipId: analytics.clipId ?? null,
							type: analytics.type,
							metadata: toPrismaJson(analytics.metadata),
							createdAt: input.now,
						},
					});
					return {
						revision,
						document: companion.mutation.document,
						kind: plan.kind,
						targetId: plan.targetId,
						asset: {
							id: resultAsset.id,
							fingerprint: resultAsset.fingerprint,
							provenance: resultAsset.provenance,
							kind: resultAsset.kind,
						},
						replayed: false,
						job: {
							id: job.id,
							workspaceId: job.workspaceId,
							projectId: job.projectId,
							clipId: job.clipId,
						},
					};
				});
			} catch (error) {
				if (
					error instanceof ClipEditorRevisionConflictError ||
					(error instanceof GeneratedMediaInsertionError &&
						error.code === "generated_media_insertion_revision_conflict")
				) {
					const current = await client.clip.findFirst({
						where: {
							id: input.request.clipId,
							projectId: input.request.projectId,
							project: { workspaceId: input.scope.workspaceId },
						},
						select: { editorRevision: true },
					});
					if (!current) return null;
					throw new GeneratedMediaInsertionError(
						"generated_media_insertion_revision_conflict",
						current.editorRevision,
					);
				}
				if (!isUniqueConstraintError(error)) throw error;
				const raced = await readReplay(client, {
					workspaceId: input.scope.workspaceId,
					idempotencyKey: input.request.idempotencyKey,
					requestFingerprint: input.requestFingerprint,
				});
				if (!raced) throw error;
				return raced;
			}
		},
	};
}

export const prismaGeneratedMediaInsertionStore =
	createPrismaGeneratedMediaInsertionStore();
