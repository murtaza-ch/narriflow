import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	clipAspectRatioFromDb,
	clipAspectRatioToDb,
	type ClipAspectRatio,
	type ClipRenderResolution,
	type SocialPlatform,
} from "@narriflow/validators";
import { clipExportService } from "./clip-export.service";
import { accessibleProjectWhere } from "./project-retention.service";
import {
	isSocialProviderPublishingEnabled,
	socialPublicationCapabilityVersion,
} from "./social-publication-config";
import { workspaceService } from "./workspace.service";
import { reviewApprovalGate } from "./review-approval-gate.prisma";
import type {
	ReviewApprovalPrincipal,
	ReviewApprovalResult,
} from "./review-approval-gate";

export type FrozenPublicationState = {
	clipExportId: string;
	clipExportVariantId: string;
	editorRevision: number;
	exportFingerprint: string;
	storageKey: string | null;
	sizeBytes: number | null;
	durationSec: number | null;
	aspectRatio: ClipAspectRatio;
	caption: string;
	providerSettings: Prisma.JsonObject;
	socialAccountId: string | null;
	platform: SocialPlatform;
	capabilityVersion: string;
	scheduledFor: Date;
};

export type PublicationIntentStatus =
	| "preparing_video"
	| "scheduled"
	| "cancelled";

export type PublicationIntent = {
	id: string;
	ownerUserId: string;
	workspaceId: string;
	projectId: string;
	clipId: string;
	clientIdempotencyKey: string;
	immutableRequestHash: string;
	status: PublicationIntentStatus;
	submissionEligible: boolean;
	reviewApprovalOverrideId: string | null;
	frozen: FrozenPublicationState;
	createdAt: Date;
	updatedAt: Date;
};

export type SchedulePublicationInput = {
	actorUserId: string;
	ownerUserId: string;
	workspaceId: string;
	projectId: string;
	clientIdempotencyKey: string;
	clipId: string;
	expectedEditorRevision: number;
	accountId: string | null;
	platform: SocialPlatform;
	caption: string;
	aspectRatio: ClipAspectRatio;
	resolution: ClipRenderResolution;
	scheduledFor: Date;
	providerSettings: Prisma.JsonObject;
	reviewOverrideReason?: string | null;
};

export type PublicationFreezeResult =
	| { kind: "ready"; state: FrozenPublicationState }
	| { kind: "preparing"; state: FrozenPublicationState };

export interface PublicationSchedulingStore {
	open(input: {
		workspaceId: string;
		clientIdempotencyKey: string;
		immutableRequestHash: string;
		create(): Promise<PublicationIntent>;
	}): Promise<PublicationIntent>;
	read(workspaceId: string, postId: string): Promise<PublicationIntent | null>;
	cancel(input: {
		workspaceId: string;
		postId: string;
		now: Date;
	}): Promise<PublicationIntent>;
	recordExportReady(input: {
		clipExportVariantId: string;
		storageKey: string;
		sizeBytes: number;
		durationSec: number;
		now: Date;
	}): Promise<void>;
}

export class PublicationIntentConflictError extends Error {
	readonly code = "publication_intent_conflict";

	constructor() {
		super(
			"The idempotency key is already bound to a different publication intent",
		);
		this.name = "PublicationIntentConflictError";
	}
}

export class PublicationIntentStateError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "PublicationIntentStateError";
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function publicationIntentHash(input: SchedulePublicationInput): string {
	return createHash("sha256")
		.update(
			canonicalJson({
				contract: "social-publication-intent-v1",
				workspaceId: input.workspaceId,
				projectId: input.projectId,
				clipId: input.clipId,
				expectedEditorRevision: input.expectedEditorRevision,
				accountId: input.accountId,
				platform: input.platform,
				caption: input.caption,
				aspectRatio: input.aspectRatio,
				resolution: input.resolution,
				scheduledFor: input.scheduledFor.toISOString(),
				providerSettings: input.providerSettings,
				reviewOverrideReason: input.reviewOverrideReason?.trim() || null,
			}),
		)
		.digest("hex");
}

export function createSocialPublicationScheduling(dependencies: {
	store: PublicationSchedulingStore;
	authorize(input: {
		actorUserId: string;
		workspaceId: string;
		permission: "publishing.manage";
	}): Promise<void>;
	authorizeReview(input: {
		principal: ReviewApprovalPrincipal;
		workspaceId: string;
		projectId: string;
		exportIds: string[];
		idempotencyKey: string;
		overrideReason?: string | null;
	}): Promise<ReviewApprovalResult>;
	freeze(input: SchedulePublicationInput): Promise<PublicationFreezeResult>;
	createId(): string;
	now(): Date;
}) {
	return {
		async schedule(
			input: SchedulePublicationInput,
		): Promise<PublicationIntent> {
			await dependencies.authorize({
				actorUserId: input.actorUserId,
				workspaceId: input.workspaceId,
				permission: "publishing.manage",
			});
			const immutableRequestHash = publicationIntentHash(input);
			return dependencies.store.open({
				workspaceId: input.workspaceId,
				clientIdempotencyKey: input.clientIdempotencyKey,
				immutableRequestHash,
				create: async () => {
					if (input.scheduledFor <= dependencies.now()) {
						throw new PublicationIntentStateError(
							"publication_schedule_in_past",
							"Choose a future publish time",
						);
					}
					const frozen = await dependencies.freeze(input);
					const review = await dependencies.authorizeReview({
						principal: {
							kind: "workspace_user",
							userId: input.actorUserId,
						},
						workspaceId: input.workspaceId,
						projectId: input.projectId,
						exportIds: [frozen.state.clipExportId],
						idempotencyKey: input.clientIdempotencyKey,
						overrideReason: input.reviewOverrideReason,
					});
					const approval = review.items.find(
						(item) => item.exportId === frozen.state.clipExportId,
					);
					if (!approval) {
						throw new PublicationIntentStateError(
							"review_approval_result_incomplete",
							"Review approval did not cover the frozen Clip Export",
						);
					}
					const now = dependencies.now();
					const ready =
						frozen.kind === "ready" &&
						frozen.state.storageKey !== null &&
						frozen.state.sizeBytes !== null;
					return {
						id: dependencies.createId(),
						ownerUserId: input.ownerUserId,
						workspaceId: input.workspaceId,
						projectId: input.projectId,
						clipId: input.clipId,
						clientIdempotencyKey: input.clientIdempotencyKey,
						immutableRequestHash,
						status: ready ? "scheduled" : "preparing_video",
						submissionEligible: ready,
						reviewApprovalOverrideId: approval.overrideAuditId,
						frozen: frozen.state,
						createdAt: now,
						updatedAt: now,
					};
				},
			});
		},

		get(workspaceId: string, postId: string) {
			return dependencies.store.read(workspaceId, postId);
		},

		async cancel(input: {
			actorUserId: string;
			workspaceId: string;
			postId: string;
		}) {
			await dependencies.authorize({
				actorUserId: input.actorUserId,
				workspaceId: input.workspaceId,
				permission: "publishing.manage",
			});
			return dependencies.store.cancel({
				workspaceId: input.workspaceId,
				postId: input.postId,
				now: dependencies.now(),
			});
		},

		recordExportReady(input: {
			clipExportVariantId: string;
			storageKey: string;
			sizeBytes: number;
			durationSec: number;
		}) {
			return dependencies.store.recordExportReady({
				...input,
				now: dependencies.now(),
			});
		},
	};
}

function cloneIntent(intent: PublicationIntent): PublicationIntent {
	return {
		...intent,
		frozen: {
			...intent.frozen,
			providerSettings: structuredClone(intent.frozen.providerSettings),
			scheduledFor: new Date(intent.frozen.scheduledFor),
		},
		createdAt: new Date(intent.createdAt),
		updatedAt: new Date(intent.updatedAt),
	};
}

export function createInMemoryPublicationSchedulingStore(): PublicationSchedulingStore & {
	count(): Promise<number>;
} {
	const intents = new Map<string, PublicationIntent>();
	const locks = new Map<string, Promise<void>>();

	async function locked<T>(
		key: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const previous = locks.get(key) ?? Promise.resolve();
		let release: () => void = () => undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.then(() => current);
		locks.set(key, queued);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (locks.get(key) === queued) locks.delete(key);
		}
	}

	return {
		async open(input) {
			const key = `${input.workspaceId}:${input.clientIdempotencyKey}`;
			return locked(key, async () => {
				const existing = intents.get(key);
				if (existing) {
					if (existing.immutableRequestHash !== input.immutableRequestHash) {
						throw new PublicationIntentConflictError();
					}
					return cloneIntent(existing);
				}
				const created = await input.create();
				intents.set(key, cloneIntent(created));
				return cloneIntent(created);
			});
		},

		async read(workspaceId, postId) {
			const found = [...intents.values()].find(
				(intent) => intent.workspaceId === workspaceId && intent.id === postId,
			);
			return found ? cloneIntent(found) : null;
		},

		async cancel(input) {
			const entry = [...intents.entries()].find(
				([, intent]) =>
					intent.workspaceId === input.workspaceId &&
					intent.id === input.postId,
			);
			if (!entry) {
				throw new PublicationIntentStateError(
					"social_post_not_found",
					"Social Post not found",
				);
			}
			const [key] = entry;
			return locked(key, async () => {
				const current = intents.get(key)!;
				if (
					current.status !== "preparing_video" &&
					current.status !== "scheduled"
				) {
					throw new PublicationIntentStateError(
						"publication_already_started",
						"The Social Post can no longer be cancelled",
					);
				}
				const cancelled: PublicationIntent = {
					...current,
					status: "cancelled",
					submissionEligible: false,
					updatedAt: input.now,
				};
				intents.set(key, cancelled);
				return cloneIntent(cancelled);
			});
		},

		async recordExportReady(input) {
			for (const [key, current] of intents) {
				if (
					current.frozen.clipExportVariantId !== input.clipExportVariantId ||
					current.status !== "preparing_video"
				) {
					continue;
				}
				intents.set(key, {
					...current,
					status: "scheduled",
					submissionEligible: true,
					frozen: {
						...current.frozen,
						storageKey: input.storageKey,
						sizeBytes: input.sizeBytes,
						durationSec: input.durationSec,
					},
					updatedAt: input.now,
				});
			}
		},

		async count() {
			return intents.size;
		},
	};
}

const publicationIntentInclude = {
	frozenState: true,
} satisfies Prisma.SocialPostInclude;

type PublicationIntentRow = Prisma.SocialPostGetPayload<{
	include: typeof publicationIntentInclude;
}>;

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function toPublicationIntent(row: PublicationIntentRow): PublicationIntent {
	const frozen = row.frozenState;
	if (
		!row.workspaceId ||
		!row.createdByUserId ||
		!row.clipId ||
		!row.clientIdempotencyKey ||
		!row.immutableRequestHash ||
		!frozen
	) {
		throw new PublicationIntentStateError(
			"publication_intent_incomplete",
			"The Social Post does not contain a complete frozen publication intent",
		);
	}
	const status =
		row.status === "preparing_video" ||
		row.status === "scheduled" ||
		row.status === "cancelled"
			? row.status
			: null;
	if (!status) {
		throw new PublicationIntentStateError(
			"publication_intent_active",
			"The Social Post is already in provider execution",
		);
	}
	return {
		id: row.id,
		ownerUserId: row.createdByUserId,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		clipId: row.clipId,
		clientIdempotencyKey: row.clientIdempotencyKey,
		immutableRequestHash: row.immutableRequestHash,
		status,
		submissionEligible:
			status === "scheduled" &&
			frozen.storageKey !== null &&
			frozen.sizeBytes !== null &&
			frozen.durationSec !== null,
		reviewApprovalOverrideId: row.reviewApprovalOverrideId,
		frozen: {
			clipExportId: frozen.clipExportId,
			clipExportVariantId: frozen.clipExportVariantId,
			editorRevision: frozen.editorRevision,
			exportFingerprint: frozen.exportFingerprint,
			storageKey: frozen.storageKey,
			sizeBytes: frozen.sizeBytes === null ? null : Number(frozen.sizeBytes),
			durationSec: frozen.durationSec,
			aspectRatio: clipAspectRatioFromDb[frozen.aspectRatio],
			caption: frozen.caption,
			providerSettings:
				frozen.providerSettings &&
				typeof frozen.providerSettings === "object" &&
				!Array.isArray(frozen.providerSettings)
					? (frozen.providerSettings as Prisma.JsonObject)
					: {},
			socialAccountId: frozen.socialAccountId,
			platform: frozen.platform,
			capabilityVersion: frozen.capabilityVersion,
			scheduledFor: frozen.scheduledFor,
		},
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

async function readIntentByKey(
	workspaceId: string,
	clientIdempotencyKey: string,
) {
	return requirePrisma().socialPost.findUnique({
		where: {
			workspaceId_clientIdempotencyKey: {
				workspaceId,
				clientIdempotencyKey,
			},
		},
		include: publicationIntentInclude,
	});
}

export const prismaPublicationSchedulingStore: PublicationSchedulingStore = {
	async open(input) {
		const existing = await readIntentByKey(
			input.workspaceId,
			input.clientIdempotencyKey,
		);
		if (existing) {
			if (existing.immutableRequestHash !== input.immutableRequestHash) {
				throw new PublicationIntentConflictError();
			}
			return toPublicationIntent(existing);
		}

		const candidate = await input.create();
		try {
			const created = await requirePrisma().$transaction(
				async (tx) => {
					const replay = await tx.socialPost.findUnique({
						where: {
							workspaceId_clientIdempotencyKey: {
								workspaceId: input.workspaceId,
								clientIdempotencyKey: input.clientIdempotencyKey,
							},
						},
						include: publicationIntentInclude,
					});
					if (replay) {
						if (replay.immutableRequestHash !== input.immutableRequestHash) {
							throw new PublicationIntentConflictError();
						}
						return replay;
					}

					if (candidate.frozen.socialAccountId) {
						const oneMinute = 60_000;
						const conflict = await tx.socialPost.findFirst({
							where: {
								workspaceId: candidate.workspaceId,
								socialAccountId: candidate.frozen.socialAccountId,
								status: {
									in: [
										"preparing_video",
										"scheduled",
										"publishing",
										"processing",
										"reconciling",
									],
								},
								scheduledFor: {
									gte: new Date(
										candidate.frozen.scheduledFor.getTime() - oneMinute,
									),
									lte: new Date(
										candidate.frozen.scheduledFor.getTime() + oneMinute,
									),
								},
							},
							select: { id: true },
						});
						if (conflict) {
							throw new PublicationIntentStateError(
								"publication_account_schedule_conflict",
								"This social account already has a post scheduled at that time",
							);
						}
					}

					const row = await tx.socialPost.create({
						data: {
							id: candidate.id,
							workspaceId: candidate.workspaceId,
							createdByUserId: candidate.ownerUserId,
							projectId: candidate.projectId,
							clipId: candidate.clipId,
							socialAccountId: candidate.frozen.socialAccountId,
							platform: candidate.frozen.platform,
							status: candidate.status,
							clientIdempotencyKey: candidate.clientIdempotencyKey,
							immutableRequestHash: candidate.immutableRequestHash,
							caption: candidate.frozen.caption,
							aspectRatio: clipAspectRatioToDb[candidate.frozen.aspectRatio],
							scheduledFor: candidate.frozen.scheduledFor,
							metadata: candidate.frozen.providerSettings,
							reviewApprovalOverrideId:
								candidate.reviewApprovalOverrideId,
							frozenState: {
								create: {
									clipExportId: candidate.frozen.clipExportId,
									clipExportVariantId: candidate.frozen.clipExportVariantId,
									socialAccountId: candidate.frozen.socialAccountId,
									platform: candidate.frozen.platform,
									editorRevision: candidate.frozen.editorRevision,
									exportFingerprint: candidate.frozen.exportFingerprint,
									storageKey: candidate.frozen.storageKey,
									sizeBytes: candidate.frozen.sizeBytes,
									durationSec: candidate.frozen.durationSec,
									aspectRatio:
										clipAspectRatioToDb[candidate.frozen.aspectRatio],
									caption: candidate.frozen.caption,
									providerSettings: candidate.frozen.providerSettings,
									capabilityVersion: candidate.frozen.capabilityVersion,
									scheduledFor: candidate.frozen.scheduledFor,
									mediaReadyAt: candidate.submissionEligible
										? candidate.createdAt
										: null,
								},
							},
						},
						include: publicationIntentInclude,
					});
					await tx.projectAnalyticsEvent.create({
						data: {
							projectId: candidate.projectId,
							clipId: candidate.clipId,
							type: "social_scheduled",
							platform: candidate.frozen.platform,
							metadata: {
								socialPostId: candidate.id,
								preparation: candidate.status === "preparing_video",
							},
						},
					});
					if (candidate.reviewApprovalOverrideId) {
						await tx.projectAnalyticsEvent.create({
							data: {
								projectId: candidate.projectId,
								clipId: candidate.clipId,
								type: "review_approval_overridden",
								platform: candidate.frozen.platform,
								metadata: {
									socialPostId: candidate.id,
									reviewApprovalOverrideId:
										candidate.reviewApprovalOverrideId,
									exportId: candidate.frozen.clipExportId,
								},
							},
						});
					}
					return row;
				},
				{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
			);
			return toPublicationIntent(created);
		} catch (error) {
			if (
				error instanceof Prisma.PrismaClientKnownRequestError &&
				(error.code === "P2002" || error.code === "P2034")
			) {
				const replay = await readIntentByKey(
					input.workspaceId,
					input.clientIdempotencyKey,
				);
				if (replay) {
					if (replay.immutableRequestHash !== input.immutableRequestHash) {
						throw new PublicationIntentConflictError();
					}
					return toPublicationIntent(replay);
				}
			}
			throw error;
		}
	},

	async read(workspaceId, postId) {
		const row = await requirePrisma().socialPost.findFirst({
			where: { id: postId, workspaceId },
			include: publicationIntentInclude,
		});
		return row ? toPublicationIntent(row) : null;
	},

	async cancel(input) {
		return requirePrisma().$transaction(async (tx) => {
			const cancelled = await tx.socialPost.updateMany({
				where: {
					id: input.postId,
					workspaceId: input.workspaceId,
					status: { in: ["preparing_video", "scheduled"] },
				},
				data: { status: "cancelled" },
			});
			if (cancelled.count === 0) {
				const exists = await tx.socialPost.findFirst({
					where: { id: input.postId, workspaceId: input.workspaceId },
					select: { id: true },
				});
				throw new PublicationIntentStateError(
					exists ? "publication_already_started" : "social_post_not_found",
					exists
						? "The Social Post can no longer be cancelled"
						: "Social Post not found",
				);
			}
			await tx.socialPublicationAttempt.deleteMany({
				where: {
					socialPostId: input.postId,
					phase: "retry_scheduled",
					currentClaimId: null,
				},
			});
			const row = await tx.socialPost.findUniqueOrThrow({
				where: { id: input.postId },
				include: publicationIntentInclude,
			});
			await tx.projectAnalyticsEvent.create({
				data: {
					projectId: row.projectId,
					clipId: row.clipId,
					type: "social_cancelled",
					platform: row.platform,
					metadata: { socialPostId: row.id },
				},
			});
			return toPublicationIntent(row);
		});
	},

	async recordExportReady(input) {
		await requirePrisma().$transaction(async (tx) => {
			const states = await tx.frozenPublicationState.findMany({
				where: {
					clipExportVariantId: input.clipExportVariantId,
					socialPost: { status: "preparing_video" },
				},
				select: { id: true, socialPostId: true },
			});
			if (states.length === 0) return;
			await tx.frozenPublicationState.updateMany({
				where: { id: { in: states.map((state) => state.id) } },
				data: {
					storageKey: input.storageKey,
					sizeBytes: input.sizeBytes,
					durationSec: input.durationSec,
					mediaReadyAt: input.now,
				},
			});
			await tx.socialPost.updateMany({
				where: {
					id: { in: states.map((state) => state.socialPostId) },
					status: "preparing_video",
				},
				data: { status: "scheduled" },
			});
		});
	},
};

export function createProductionSocialPublicationScheduling() {
	return createSocialPublicationScheduling({
		store: prismaPublicationSchedulingStore,
		authorize: async ({ actorUserId, workspaceId, permission }) => {
			await workspaceService.requireActor(actorUserId, workspaceId, permission);
		},
		authorizeReview: (input) => reviewApprovalGate.authorize(input),
		async freeze(input) {
			if (!isSocialProviderPublishingEnabled(input.platform)) {
				throw new PublicationIntentStateError(
					"social_provider_publishing_disabled",
					"Publishing for this provider is not enabled yet",
				);
			}
			const prisma = requirePrisma();
			const project = await prisma.project.findFirst({
				where: {
					id: input.projectId,
					workspaceId: input.workspaceId,
					...accessibleProjectWhere(),
				},
				select: { id: true },
			});
			if (!project) {
				throw new PublicationIntentStateError(
					"project_not_found",
					"Project not found",
				);
			}
			const clip = await prisma.clip.findFirst({
				where: { id: input.clipId, projectId: input.projectId },
				select: { id: true, editorRevision: true },
			});
			if (!clip) {
				throw new PublicationIntentStateError(
					"clip_not_found",
					"Clip not found",
				);
			}
			if (clip.editorRevision !== input.expectedEditorRevision) {
				throw new PublicationIntentStateError(
					"editor_revision_conflict",
					"The clip changed before the publication intent was frozen",
				);
			}
			if (input.accountId) {
				const account = await prisma.socialAccount.findFirst({
					where: {
						id: input.accountId,
						workspaceId: input.workspaceId,
						platform: input.platform,
						status: "active",
					},
					select: { id: true },
				});
				if (!account) {
					throw new PublicationIntentStateError(
						"social_account_unavailable",
						"The selected social account is unavailable for this platform",
					);
				}
			}

			const requested = await clipExportService.create(
				input.projectId,
				input.clipId,
				{
					expectedRevision: input.expectedEditorRevision,
					aspectRatios: [input.aspectRatio],
					resolution: input.resolution,
				},
				`social:${input.workspaceId}:${input.clientIdempotencyKey}`,
				{
					workspaceId: input.workspaceId,
					actorUserId: input.actorUserId,
				},
			);
			const row = await prisma.clipExport.findUniqueOrThrow({
				where: { id: requested.export.id },
				include: {
					variants: {
						where: { aspectRatio: clipAspectRatioToDb[input.aspectRatio] },
					},
				},
			});
			const variant = row.variants[0];
			if (!variant) {
				throw new PublicationIntentStateError(
					"publication_export_variant_missing",
					"The exact Clip Export Variant could not be prepared",
				);
			}
			if (variant.status === "failed") {
				throw new PublicationIntentStateError(
					variant.errorCode ?? "publication_media_preparation_failed",
					"The exact Clip Export Variant failed to render",
				);
			}
			const state: FrozenPublicationState = {
				clipExportId: row.id,
				clipExportVariantId: variant.id,
				editorRevision: row.editorRevision,
				exportFingerprint: row.fingerprint,
				storageKey: variant.status === "completed" ? variant.storageKey : null,
				sizeBytes:
					variant.status === "completed" && variant.sizeBytes !== null
						? Number(variant.sizeBytes)
						: null,
				durationSec:
					variant.status === "completed" ? variant.durationSec : null,
				aspectRatio: input.aspectRatio,
				caption: input.caption,
				providerSettings: input.providerSettings,
				socialAccountId: input.accountId,
				platform: input.platform,
				capabilityVersion:
					input.accountId === null
						? "publication-webhook-v1"
						: socialPublicationCapabilityVersion(input.platform),
				scheduledFor: input.scheduledFor,
			};
			return {
				kind:
					state.storageKey !== null &&
					state.sizeBytes !== null &&
					state.durationSec !== null
						? "ready"
						: "preparing",
				state,
			};
		},
		createId: randomUUID,
		now: () => new Date(),
	});
}
