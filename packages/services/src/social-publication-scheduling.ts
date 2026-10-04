import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { workspaceAllowsCapability, type ClipAspectRatio, type ClipRenderResolution, type SocialPlatform, type SocialDeliveryMode, type SocialPostStatus } from "@narriflow/validators";
import type { BrandActorScope } from "./brand-ownership";
import { ThumbnailPreparationError, validateThumbnailSelection, validateProviderThumbnailAsset, type ThumbnailSelection } from "./thumbnail-frame-preparation";
import type { ReviewApprovalPrincipal, ReviewApprovalResult } from "./review-approval-gate";
import { ExpectedDomainFailureError, type ExpectedDomainFailureCatalog } from "./expected-domain-failure";

export type FrozenPublicationState = {
	deliveryMode?: import("@narriflow/validators").SocialDeliveryMode;
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

export type PublicationIntentStatus = SocialPostStatus;
export type PublicationSchedulingActor = BrandActorScope;

export type PublicationIntent = {
	id: string;
	createdByUserId: string;
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
	workspaceId: string;
	projectId: string;
	clientIdempotencyKey: string;
	clipId: string;
	expectedEditorRevision: number;
	clipExportId?: string;
	clipExportVariantId?: string;
	accountId: string | null;
	platform: SocialPlatform;
	caption: string;
	aspectRatio: ClipAspectRatio;
	resolution: ClipRenderResolution;
	scheduledFor: Date;
	immediate?: boolean;
	providerSettings: Prisma.JsonObject;
	deliveryMode?: SocialDeliveryMode;
	assistedCopyVariantId?: string | null;
	thumbnail?: ThumbnailSelection | null;
	reviewOverrideReason?: string | null;
	beforeAccept?: () => Promise<void>;
};

export type PublicationFreezeResult =
	| { kind: "ready"; state: FrozenPublicationState }
	| { kind: "preparing"; state: FrozenPublicationState };

export type PublicationExportFacts = {
	id: string;
	workspaceId: string | null;
	projectId: string;
	clipId: string;
	editorRevision: number;
	resolution: string;
	fingerprint: string;
	variants: Array<{
		id: string;
		aspectRatio: ClipAspectRatio;
		resolution: string;
		status: string;
		storageKey: string | null;
		sizeBytes: number | null;
		durationSec: number | null;
	}>;
};

export interface PublicationFreezePorts {
	providerEnabled(platform: SocialPlatform): boolean;
	capabilityVersion(platform: SocialPlatform): string;
	projectExists(input: { workspaceId: string; projectId: string }): Promise<boolean>;
	readClip(input: { workspaceId: string; projectId: string; clipId: string }): Promise<{ editorRevision: number } | null>;
	readAccount(accountId: string): Promise<{
		workspaceId: string | null;
		platform: SocialPlatform;
		status: string;
		expiresAt: Date | null;
		canRefresh: boolean;
	} | null>;
	readExport(exportId: string): Promise<PublicationExportFacts | null>;
	createExport(input: SchedulePublicationInput): Promise<string>;
	tiktokOptions(input: { workspaceId: string; accountId: string }): Promise<{
		inboxEnabled: boolean;
		directEnabled: boolean;
		privacyOptions: string[];
		commentDisabled: boolean;
		duetDisabled: boolean;
		stitchDisabled: boolean;
		maximumDurationSec: number;
	}>;
	requireCopyProvenance(input: {
		workspaceId: string; projectId: string; clipId: string;
		platform: SocialPlatform; variantId: string;
	}): Promise<void>;
	readThumbnailAsset(input: { actor: PublicationSchedulingActor; selection: ThumbnailSelection }): Promise<{
		id: string; contentType: string; sizeBytes: bigint;
	} | null>;
	thumbnailFrameMatches(input: {
		workspaceId: string; projectId: string; clipId: string; assetId: string;
		sourceTimeMs: number; exportVariantId: string; aspectRatio: ClipAspectRatio; editorRevision: number;
	}): Promise<boolean>;
}

export interface PublicationSchedulingStore {
	open(input: {
		workspaceId: string;
		clientIdempotencyKey: string;
		immutableRequestHash: string;
		create(): Promise<PublicationIntent>;
	}): Promise<PublicationIntent>;
	readByKey(
		workspaceId: string,
		clientIdempotencyKey: string,
	): Promise<PublicationIntent | null>;
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

const publicationIntentFailureCatalog = {
	clip_not_found: "missing",
	editor_revision_conflict: "conflict",
	project_not_found: "missing",
	publication_already_started: "conflict",
	publication_export_mismatch: "conflict",
	publication_export_variant_missing: "missing",
	publication_intent_conflict: "conflict",
	publication_intent_incomplete: "unprocessable",
	publication_media_preparation_failed: "unavailable",
	publication_schedule_in_past: "invalid",
	review_approval_result_incomplete: "unavailable",
	social_account_expired: "unprocessable",
	social_account_unavailable: "missing",
	social_post_not_found: "missing",
	social_provider_publishing_disabled: "unavailable",
	social_account_scope_missing: "unavailable",
	tiktok_creator_settings_changed: "invalid",
	tiktok_video_too_long: "invalid",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export class PublicationIntentConflictError extends ExpectedDomainFailureError<"publication_intent_conflict"> {
	constructor() {
		super({
			code: "publication_intent_conflict",
			kind: publicationIntentFailureCatalog.publication_intent_conflict,
			message:
				"The idempotency key is already bound to a different publication intent",
		});
		this.name = "PublicationIntentConflictError";
	}
}

type PublicationIntentStateErrorCode = Exclude<
	keyof typeof publicationIntentFailureCatalog,
	"publication_intent_conflict"
>;

export class PublicationIntentStateError extends ExpectedDomainFailureError<PublicationIntentStateErrorCode> {
	constructor(code: PublicationIntentStateErrorCode, message: string) {
		super({ code, kind: publicationIntentFailureCatalog[code], message });
		this.name = "PublicationIntentStateError";
	}
}

export function socialAccountCanPublishAt(
	account: { expiresAt: Date | null; canRefresh: boolean },
	now: Date,
): boolean {
	return (
		!account.expiresAt ||
		account.expiresAt > now ||
		account.canRefresh
	);
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
				immediate: input.immediate === true,
				workspaceId: input.workspaceId,
				projectId: input.projectId,
				clipId: input.clipId,
				expectedEditorRevision: input.expectedEditorRevision,
				clipExportId: input.clipExportId ?? null,
				clipExportVariantId: input.clipExportVariantId ?? null,
				accountId: input.accountId,
				platform: input.platform,
				caption: input.caption,
				aspectRatio: input.aspectRatio,
				resolution: input.resolution,
				scheduledFor: input.scheduledFor.toISOString(),
				providerSettings: input.providerSettings,
				deliveryMode: input.deliveryMode ?? "direct",
				assistedCopyVariantId: input.assistedCopyVariantId ?? null,
				thumbnail: input.thumbnail ?? null,
				reviewOverrideReason: input.reviewOverrideReason?.trim() || null,
			}),
		)
		.digest("hex");
}

async function freezePublication(
	input: SchedulePublicationInput,
	actor: PublicationSchedulingActor,
	ports: PublicationFreezePorts,
	now: Date,
): Promise<PublicationFreezeResult> {
	if (!ports.providerEnabled(input.platform)) {
		throw new PublicationIntentStateError("social_provider_publishing_disabled", "Publishing for this provider is not enabled yet");
	}
	if (!await ports.projectExists(input)) {
		throw new PublicationIntentStateError("project_not_found", "Project not found");
	}
	const clip = await ports.readClip(input);
	if (!clip) throw new PublicationIntentStateError("clip_not_found", "Clip not found");
	if (clip.editorRevision !== input.expectedEditorRevision) {
		throw new PublicationIntentStateError("editor_revision_conflict", "The clip changed before the publication intent was frozen");
	}
	if (input.accountId) {
		const account = await ports.readAccount(input.accountId);
		if (!account || account.workspaceId !== input.workspaceId || account.platform !== input.platform || account.status !== "active") {
			throw new PublicationIntentStateError("social_account_unavailable", "The selected social account is unavailable for this platform");
		}
		if (!socialAccountCanPublishAt(account, now)) {
			throw new PublicationIntentStateError("social_account_expired", "The selected social account token has expired");
		}
	}
	const deliveryMode = input.deliveryMode ?? "direct";
	const providerSettings: Prisma.JsonObject = {
		...input.providerSettings,
		deliveryMode,
		confirmedBy: input.actorUserId,
	};
	if (input.assistedCopyVariantId) {
		await ports.requireCopyProvenance({
			workspaceId: input.workspaceId, projectId: input.projectId, clipId: input.clipId,
			platform: input.platform, variantId: input.assistedCopyVariantId,
		});
		providerSettings.assistedCopyVariantId = input.assistedCopyVariantId;
	}
	let thumbnailAssetId: string | null = null;
	if (input.thumbnail) {
		const normalized = validateThumbnailSelection({ platform: input.platform, selection: input.thumbnail });
		const asset = await ports.readThumbnailAsset({ actor, selection: input.thumbnail });
		if (!asset) throw new ThumbnailPreparationError("thumbnail_asset_unavailable", "The selected thumbnail is missing or was deleted");
		validateProviderThumbnailAsset({ platform: input.platform, contentType: asset.contentType, sizeBytes: asset.sizeBytes });
		thumbnailAssetId = asset.id;
		Object.assign(providerSettings, normalized);
	}
	const exportId = input.clipExportId ?? await ports.createExport(input);
	const exported = await ports.readExport(exportId);
	if (!exported || exported.workspaceId !== input.workspaceId || exported.projectId !== input.projectId ||
		exported.clipId !== input.clipId || exported.editorRevision !== input.expectedEditorRevision || exported.resolution !== input.resolution) {
		throw new PublicationIntentStateError("publication_export_mismatch", "The selected Clip Export is no longer current for this publication");
	}
	const variant = exported.variants.find((candidate) =>
		(!input.clipExportVariantId || candidate.id === input.clipExportVariantId) &&
		candidate.aspectRatio === input.aspectRatio && candidate.resolution === input.resolution);
	if (!variant) throw new PublicationIntentStateError("publication_export_variant_missing", "The exact Clip Export Variant could not be prepared");
	if (variant.status === "failed") throw new PublicationIntentStateError("publication_media_preparation_failed", "The exact Clip Export Variant failed to render");
	if (input.clipExportId && (variant.status !== "completed" || !variant.storageKey || variant.sizeBytes === null || variant.durationSec === null)) {
		throw new PublicationIntentStateError("publication_media_preparation_failed", "Prepare the selected video before submitting.");
	}
	if (input.thumbnail?.source === "extracted_frame" && !await ports.thumbnailFrameMatches({
		workspaceId: input.workspaceId, projectId: input.projectId, clipId: input.clipId,
		assetId: thumbnailAssetId!, sourceTimeMs: input.thumbnail.sourceTimeMs!,
		exportVariantId: variant.id, aspectRatio: input.aspectRatio, editorRevision: input.expectedEditorRevision,
	})) {
		throw new ThumbnailPreparationError("thumbnail_export_mismatch", "The frame does not belong to the selected export revision");
	}
	if (input.platform === "tiktok" && input.accountId) {
		const options = await ports.tiktokOptions({ workspaceId: input.workspaceId, accountId: input.accountId });
		const inbox = deliveryMode === "tiktok_inbox";
		if (inbox ? !options.inboxEnabled : !options.directEnabled) {
			throw new PublicationIntentStateError("social_account_scope_missing", "Reconnect TikTok to allow this delivery mode.");
		}
		if (!inbox && (!options.privacyOptions.includes(String(providerSettings.tiktokPrivacyLevel ?? "")) ||
			(options.commentDisabled && providerSettings.disableComment !== true) ||
			(options.duetDisabled && providerSettings.disableDuet !== true) ||
			(options.stitchDisabled && providerSettings.disableStitch !== true))) {
			throw new PublicationIntentStateError("tiktok_creator_settings_changed", "TikTok settings changed. Reload the account settings and review this post.");
		}
		if (variant.durationSec && variant.durationSec > options.maximumDurationSec) {
			throw new PublicationIntentStateError("tiktok_video_too_long", "This video exceeds the account's duration limit.");
		}
	}
	const state: FrozenPublicationState = {
		deliveryMode, clipExportId: exported.id, clipExportVariantId: variant.id,
		editorRevision: exported.editorRevision, exportFingerprint: exported.fingerprint,
		storageKey: variant.status === "completed" ? variant.storageKey : null,
		sizeBytes: variant.status === "completed" ? variant.sizeBytes : null,
		durationSec: variant.status === "completed" ? variant.durationSec : null,
		aspectRatio: input.aspectRatio, caption: input.caption, providerSettings,
		socialAccountId: input.accountId, platform: input.platform,
		capabilityVersion: input.accountId === null ? "publication-webhook-v1" : ports.capabilityVersion(input.platform),
		scheduledFor: input.scheduledFor,
	};
	return { kind: state.storageKey !== null && state.sizeBytes !== null && state.durationSec !== null ? "ready" : "preparing", state };
}

export function createSocialPublicationScheduling(dependencies: {
	store: PublicationSchedulingStore;
	authorize(input: {
		actorUserId: string;
		workspaceId: string;
		permission: "publishing.manage";
	}): Promise<PublicationSchedulingActor>;
	authorizeReview(input: {
		principal: ReviewApprovalPrincipal;
		workspaceId: string;
		projectId: string;
		exportIds: string[];
		idempotencyKey: string;
		overrideReason?: string | null;
	}): Promise<ReviewApprovalResult>;
	freezePorts: PublicationFreezePorts;
	createId(): string;
	now(): Date;
}) {
	async function requireActor(
		input: SchedulePublicationInput,
		options?: { actor: PublicationSchedulingActor },
	) {
		const actor = options?.actor ??
			await dependencies.authorize({
				actorUserId: input.actorUserId,
				workspaceId: input.workspaceId,
				permission: "publishing.manage",
			});
		if (
			actor.actorUserId !== input.actorUserId ||
			actor.workspaceId !== input.workspaceId ||
			!workspaceAllowsCapability(actor, "publishing.manage")
		) {
			throw new ExpectedDomainFailureError({
				code: "workspace_access_denied",
				kind: "forbidden",
				message: "You do not have permission to publish in this Workspace",
			});
		}
		return actor;
	}

	return {
		async replay(
			input: SchedulePublicationInput,
			options?: { actor: PublicationSchedulingActor },
		): Promise<PublicationIntent | null> {
			await requireActor(input, options);
			const accepted = await dependencies.store.readByKey(
				input.workspaceId,
				input.clientIdempotencyKey,
			);
			if (
				accepted &&
				accepted.immutableRequestHash !== publicationIntentHash(input)
			) {
				throw new PublicationIntentConflictError();
			}
			return accepted;
		},

		async schedule(
			input: SchedulePublicationInput,
			options?: { actor: PublicationSchedulingActor },
		): Promise<PublicationIntent> {
			const actor = await requireActor(input, options);
			const immutableRequestHash = publicationIntentHash(input);
			return dependencies.store.open({
				workspaceId: input.workspaceId,
				clientIdempotencyKey: input.clientIdempotencyKey,
				immutableRequestHash,
				create: async () => {
					if (!input.immediate && input.scheduledFor <= dependencies.now()) {
						throw new PublicationIntentStateError(
							"publication_schedule_in_past",
							"Choose a future publish time",
						);
					}
					await input.beforeAccept?.();
					const frozen = await freezePublication(input, actor, dependencies.freezePorts, dependencies.now());
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
						createdByUserId: input.actorUserId,
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

		async readByKey(workspaceId, clientIdempotencyKey) {
			const found = intents.get(`${workspaceId}:${clientIdempotencyKey}`);
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
