import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	clipAspectRatioFromDb,
	postingScheduleSchema,
	SOCIAL_PROVIDER_CAPABILITIES,
	socialProviderAcceptsMedia,
	sortedPostingSchedule,
	type AcceptSocialPostProposalInput,
	type ClipRenderResolution,
	type PostingSchedule,
	type ProposeSocialPostInput,
	type SocialPlatform,
	type SocialPostProposalSource,
	type SocialPostProposalView,
	type SocialPostStatus,
} from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import { composeAssistedCopyCaption } from "./assisted-social-copy";
import { ExpectedDomainFailureError, type ExpectedDomainFailureCatalog } from "./expected-domain-failure";
import type { IntegrationMutation } from "./operation-receipt";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { nextFreeSlots, parsePostingSchedule } from "./posting-schedule";
import { accessibleProjectWhere } from "./project-access";
import type { PublicationSlotQueue } from "./social-publication-scheduling";
import { socialPublicationScheduling } from "./social-publication-scheduling-runtime";
import { workspaceService } from "./workspace.service";
import { requirePlanFeature } from "./plan-features";
import { readPublishableSocialAccountIds, requirePublishableSocialAccount, socialAccountBeyondPlanError } from "./social-account-eligibility";
import { isSocialProviderPublishingEnabled } from "./social-publication-config";
import { flushWorkspaceEvents, queueWorkspaceEvent } from "./workspace-event";

/** The Publishing Queue: weekly posting slots on each Social Account, and
 * proposals that wait, in the unused `draft` Social Post status, for a person
 * to accept them into the account's next free slot.
 *
 * A proposal takes no slot and has no `scheduledFor`, so the publication
 * scheduler (which claims only `scheduled` posts with media ready) and
 * recovery (which needs an attempt and a frozen state) never see it. Accepting
 * runs the ordinary prepare-and-schedule path, with the slot chosen under the
 * account's row lock in the transaction that writes the post. */

const queueFailureCatalog = {
	clip_export_not_found: "missing",
	editor_revision_conflict: "conflict",
	posting_schedule_missing: "unprocessable",
	finishing_queue_format_unsupported: "unprocessable",
	social_account_unavailable: "missing",
	social_proposal_caption_required: "invalid",
	social_proposal_caption_too_long: "invalid",
	social_proposal_limit_reached: "conflict",
	social_proposal_not_found: "missing",
	social_proposal_tiktok_options_required: "invalid",
	social_proposal_variant_unavailable: "unprocessable",
	social_provider_publishing_disabled: "unavailable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export class PublishingQueueError extends ExpectedDomainFailureError<keyof typeof queueFailureCatalog> {
	constructor(code: keyof typeof queueFailureCatalog, message: string) {
		super({ code, kind: queueFailureCatalog[code], message });
		this.name = "PublishingQueueError";
	}
}

/** A Workspace holds this many proposals at once, so an integration that loops can't bury the inbox. */
export const MAX_OPEN_PROPOSALS = 200;
/** One "Accept all" call works through this many, oldest first, so a long inbox
 * never outlasts a request; the caller continues from `nextCursor`. */
export const ACCEPT_ALL_BATCH = 25;

/** A proposal's own key, written when it is made and kept when it is accepted. It is not a UUID,
 * which is all any client or integration can choose, so nobody can claim it ahead of time, and a
 * retry after a lost response finds the post the first attempt made. */
export const proposalAcceptKey = (proposalId: string) => `proposal-accept:${proposalId}`;

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function sha256(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

const proposalSelect = {
	id: true,
	projectId: true,
	clipId: true,
	socialAccountId: true,
	platform: true,
	caption: true,
	createdAt: true,
	proposal: {
		select: {
			source: true,
			title: true,
			assistedCopyVariantId: true,
			clipExportVariantId: true,
			clipExportVariant: { select: { exportId: true, aspectRatio: true, resolution: true, durationSec: true, export: { select: { editorRevision: true } } } },
		},
	},
} satisfies Prisma.SocialPostSelect;

type ProposalRow = Prisma.SocialPostGetPayload<{ select: typeof proposalSelect }>;

function proposalWhere(workspaceId: string): Prisma.SocialPostWhereInput {
	return {
		workspaceId,
		status: "draft",
		proposal: { isNot: null },
		project: { workspaceId, ...accessibleProjectWhere() },
	};
}

function toProposalView(row: ProposalRow): SocialPostProposalView {
	const proposal = row.proposal!;
	return {
		proposalId: row.id,
		projectId: row.projectId,
		clipId: row.clipId!,
		socialAccountId: row.socialAccountId!,
		platform: row.platform,
		caption: row.caption,
		source: proposal.source,
		exportId: proposal.clipExportVariant.exportId,
		exportVariantId: proposal.clipExportVariantId,
		aspectRatio: clipAspectRatioFromDb[proposal.clipExportVariant.aspectRatio],
		createdAt: row.createdAt.toISOString(),
	};
}

/** The instants at which an account has an active post, from `from` on. */
async function occupiedSlots(
	db: Pick<Prisma.TransactionClient, "socialPost">,
	accountIds: string[],
	from: Date,
): Promise<Map<string, Set<number>>> {
	const posts = await db.socialPost.findMany({
		where: { socialAccountId: { in: accountIds }, scheduledFor: { gt: from }, status: { notIn: ["draft", "cancelled", "failed"] } },
		select: { socialAccountId: true, scheduledFor: true },
	});
	const byAccount = new Map<string, Set<number>>(accountIds.map((id) => [id, new Set()]));
	for (const post of posts) {
		if (post.socialAccountId && post.scheduledFor) byAccount.get(post.socialAccountId)?.add(post.scheduledFor.getTime());
	}
	return byAccount;
}

/** The queue as bulk scheduling sees it: each account's schedule, and what it already occupies. */
export async function readQueueSlots(workspaceId: string, accountIds: string[], from: Date) {
	const prisma = requirePrisma();
	const accounts = await prisma.socialAccount.findMany({ where: { id: { in: accountIds }, workspaceId }, select: { id: true, postingSchedule: true } });
	return {
		schedules: new Map(accounts.map((account) => [account.id, parsePostingSchedule(account.postingSchedule)])),
		occupied: await occupiedSlots(prisma, accountIds, from),
	};
}

export interface ProposalInboxItem extends SocialPostProposalView {
	projectTitle: string;
	clipTitle: string;
	accountDisplayName: string;
	accountHandle: string | null;
	accountStatus: string;
	hasPostingSchedule: boolean;
	durationSec: number | null;
	/** Where this proposal would land if accepted now, counting the proposals ahead of it. */
	nextSlot: string | null;
}

export interface AcceptedProposal {
	socialPostId: string;
	projectId: string;
	clipId: string;
	platform: SocialPlatform;
	status: SocialPostStatus;
	scheduledFor: string;
	replayed: boolean;
}

export const publishingQueue = {
	/** Replaces the account's weekly slots; an empty schedule clears them. */
	async setPostingSchedule(scope: ActorScope, accountId: string, schedule: PostingSchedule | null): Promise<PostingSchedule | null> {
		const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "publishing.manage");
		const saved = schedule ? postingScheduleSchema.parse(schedule) : null;
		const normalized = saved && saved.slots.length > 0 ? sortedPostingSchedule(saved) : null;
		// Clearing a schedule stays possible on any plan.
		if (normalized) requirePlanFeature(actor.pricingTier, "publishing.schedule");
		const updated = await requirePrisma().socialAccount.updateMany({
			where: { id: accountId, workspaceId: scope.workspaceId, status: { not: "revoked" } },
			data: { postingSchedule: normalized ?? Prisma.DbNull },
		});
		if (updated.count === 0) throw new PublishingQueueError("social_account_unavailable", "This account isn't connected to the Workspace.");
		return normalized;
	},

	/** One connected account's weekly slots, or null when it has none. */
	async getPostingSchedule(scope: ActorScope, accountId: string): Promise<PostingSchedule | null> {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		const account = await requirePrisma().socialAccount.findFirst({
			where: { id: accountId, workspaceId: scope.workspaceId, status: { not: "revoked" } },
			select: { postingSchedule: true },
		});
		if (!account) throw new PublishingQueueError("social_account_unavailable", "This account isn't connected to the Workspace.");
		return parsePostingSchedule(account.postingSchedule);
	},

	/** Records one proposal. The receipt makes a retry with the same key return the first proposal;
	 * the proposal row, its event and the receipt commit together. */
	async propose(
		scope: ActorScope,
		input: ProposeSocialPostInput,
		options: {
			source: SocialPostProposalSource;
			mutation: IntegrationMutation;
			/** Finishing's own copy generation, whose variant for the platform is the caption. */
			copyGenerationId?: string;
		},
	): Promise<{ proposal: SocialPostProposalView; replayed: boolean }> {
		let tier: string | null = null;
		const accepted = await getOperationReceiptExecutor().execute<SocialPostProposalView>({
			identity: { workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, command: "propose_social_post", clientIdempotencyKey: options.mutation.clientIdempotencyKey },
			// The source stays out of the request: the same key through another transport replays.
			input: { clipId: input.clipId, exportId: input.exportId, socialAccountId: input.socialAccountId, caption: input.caption ?? null },
			authorize: async () => {
				tier = (await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "publishing.manage")).pricingTier;
			},
			beforeAccept: options.mutation.beforeAccept,
			mutate: async (tx) => {
				const account = await tx.socialAccount.findFirst({
					where: { id: input.socialAccountId, workspaceId: scope.workspaceId, status: "active" },
					select: { id: true, platform: true },
				});
				if (!account) throw new PublishingQueueError("social_account_unavailable", "Connect this account again, or choose another. List the Workspace's accounts for current IDs.");
				// Refuse up front, like scheduling does, rather than queue a proposal that can't be accepted.
				if (!isSocialProviderPublishingEnabled(account.platform)) throw new PublishingQueueError("social_provider_publishing_disabled", "Publishing to this platform isn't available yet. Choose another account.");
				await requirePublishableSocialAccount(tx, { workspaceId: scope.workspaceId, accountId: account.id, tier });
				const exported = await tx.clipExport.findFirst({
					where: { id: input.exportId, clipId: input.clipId, workspaceId: scope.workspaceId, project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() } },
					select: {
						projectId: true,
						editorRevision: true,
						clip: { select: { editorRevision: true } },
						variants: { select: { id: true, aspectRatio: true, status: true, storageKey: true, sizeBytes: true, durationSec: true } },
					},
				});
				if (!exported) throw new PublishingQueueError("clip_export_not_found", "This export doesn't exist for that clip in the Workspace. Use the export ID returned when it was requested.");
				if (exported.clip.editorRevision !== exported.editorRevision) {
					throw new ExpectedDomainFailureError({ code: "editor_revision_conflict", kind: "conflict", message: "The clip changed after this export. Export its current revision and propose that." });
				}
				// The first format the platform lists that this export finished.
				const capability = SOCIAL_PROVIDER_CAPABILITIES[account.platform];
				let variant: (typeof exported.variants)[number] | undefined;
				for (const ratio of capability.aspectRatios) {
					variant = exported.variants.find((candidate) =>
						clipAspectRatioFromDb[candidate.aspectRatio] === ratio && candidate.status === "completed" && candidate.storageKey && candidate.sizeBytes !== null
						&& candidate.durationSec !== null && socialProviderAcceptsMedia({ platform: account.platform, aspectRatio: ratio, durationSec: candidate.durationSec }));
					if (variant) break;
				}
				if (!variant) throw new PublishingQueueError("social_proposal_variant_unavailable", "This export has no finished format that this platform accepts. Wait for the export to finish, or export another format.");

				const copy = input.caption === undefined
					? await tx.assistedCopyVariant.findFirst({
						where: options.copyGenerationId
							? { generationId: options.copyGenerationId, platform: account.platform }
							: { platform: account.platform, generation: { workspaceId: scope.workspaceId, clipId: input.clipId, status: "completed" } },
						orderBy: { createdAt: "desc" },
					})
					: null;
				const caption = input.caption ?? (copy ? composeAssistedCopyCaption({ caption: copy.caption, hashtags: copy.hashtags as string[] }) : "");
				if (caption.length > capability.textLimit) {
					throw new PublishingQueueError("social_proposal_caption_too_long", `This platform allows ${capability.textLimit} characters.`);
				}
				const open = await tx.socialPost.count({ where: { workspaceId: scope.workspaceId, status: "draft", proposal: { isNot: null } } });
				if (open >= MAX_OPEN_PROPOSALS) throw new PublishingQueueError("social_proposal_limit_reached", `A Workspace can hold ${MAX_OPEN_PROPOSALS} proposals. Accept or reject some first.`);

				const id = randomUUID();
				const row = await tx.socialPost.create({
					data: {
						id,
						workspaceId: scope.workspaceId,
						createdByUserId: scope.actorUserId,
						projectId: exported.projectId,
						clipId: input.clipId,
						socialAccountId: account.id,
						platform: account.platform,
						status: "draft",
						// A proposal has no request to key; its acceptance's key is reserved from the start.
						clientIdempotencyKey: proposalAcceptKey(id),
						immutableRequestHash: sha256(JSON.stringify(["proposal-v1", id, variant.id, caption])),
						caption,
						aspectRatio: variant.aspectRatio,
						proposal: { create: { source: options.source, clipExportVariantId: variant.id, assistedCopyVariantId: copy?.id ?? null, title: copy?.title ?? null } },
					},
					select: proposalSelect,
				});
				// The event is queued, then flushed as this transaction's last act.
				queueWorkspaceEvent(tx, {
					workspaceId: scope.workspaceId,
					projectId: exported.projectId,
					type: "social_post.proposed",
					subject: { socialPostId: id, projectId: exported.projectId, clipId: input.clipId, socialAccountId: account.id, platform: account.platform },
					dedupeKey: `social_post.proposed:${id}`,
				});
				await flushWorkspaceEvents(tx);
				return { resourceType: "social_post", resourceId: id, value: toProposalView(row) };
			},
		});
		return { proposal: accepted.value, replayed: accepted.replayed };
	},

	/** The Workspace's open proposals, oldest first. */
	async listProposals(scope: ActorScope): Promise<ProposalInboxItem[]> {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		const prisma = requirePrisma();
		const rows = await prisma.socialPost.findMany({
			where: proposalWhere(scope.workspaceId),
			orderBy: [{ createdAt: "asc" }, { id: "asc" }],
			take: MAX_OPEN_PROPOSALS,
			select: {
				...proposalSelect,
				project: { select: { title: true } },
				clip: { select: { title: true, hookText: true } },
				socialAccount: { select: { displayName: true, handle: true, status: true, postingSchedule: true } },
			},
		});
		if (rows.length === 0) return [];
		const accountIds = [...new Set(rows.flatMap((row) => (row.socialAccountId ? [row.socialAccountId] : [])))];
		const [workspace, occupied] = await Promise.all([
			prisma.workspace.findUnique({ where: { id: scope.workspaceId }, select: { timezone: true } }),
			occupiedSlots(prisma, accountIds, new Date()),
		]);
		const timeZone = workspace?.timezone ?? "UTC";
		const now = new Date();
		const upcoming = new Map<string, Date[]>();
		for (const accountId of accountIds) {
			const account = rows.find((row) => row.socialAccountId === accountId)!.socialAccount;
			const schedule = account ? parsePostingSchedule(account.postingSchedule) : null;
			const waiting = rows.filter((row) => row.socialAccountId === accountId).length;
			upcoming.set(accountId, schedule ? nextFreeSlots({ schedule, timeZone, after: now, occupied: occupied.get(accountId) ?? new Set(), count: waiting }) : []);
		}
		const seen = new Map<string, number>();
		return rows.filter((row) => row.proposal && row.socialAccountId && row.clipId).map((row) => {
			const index = seen.get(row.socialAccountId!) ?? 0;
			seen.set(row.socialAccountId!, index + 1);
			return {
				...toProposalView(row),
				projectTitle: row.project.title,
				clipTitle: row.clip?.title?.trim() || row.clip?.hookText || "Clip",
				accountDisplayName: row.socialAccount?.displayName ?? "Account",
				accountHandle: row.socialAccount?.handle ?? null,
				accountStatus: row.socialAccount?.status ?? "revoked",
				hasPostingSchedule: Boolean(row.socialAccount && parsePostingSchedule(row.socialAccount.postingSchedule)),
				durationSec: row.proposal!.clipExportVariant.durationSec,
				nextSlot: upcoming.get(row.socialAccountId!)?.[index]?.toISOString() ?? null,
			};
		});
	},

	/** How many proposals wait, for the badge on the calendar. */
	async countProposals(scope: ActorScope): Promise<number> {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		return requirePrisma().socialPost.count({ where: proposalWhere(scope.workspaceId) });
	},

	async updateProposalCaption(scope: ActorScope, proposalId: string, caption: string): Promise<void> {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "publishing.manage");
		const prisma = requirePrisma();
		const proposal = await prisma.socialPost.findFirst({ where: { id: proposalId, ...proposalWhere(scope.workspaceId) }, select: { platform: true } });
		if (!proposal) throw new PublishingQueueError("social_proposal_not_found", "This proposal was already accepted or rejected.");
		const limit = SOCIAL_PROVIDER_CAPABILITIES[proposal.platform].textLimit;
		if (caption.length > limit) throw new PublishingQueueError("social_proposal_caption_too_long", `This platform allows ${limit} characters.`);
		const updated = await prisma.socialPost.updateMany({ where: { id: proposalId, ...proposalWhere(scope.workspaceId) }, data: { caption } });
		if (updated.count === 0) throw new PublishingQueueError("social_proposal_not_found", "This proposal was already accepted or rejected.");
	},

	/** Cancels a proposal. It never held a slot, so nothing else changes. */
	async reject(scope: ActorScope, proposalId: string): Promise<void> {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "publishing.manage");
		const rejected = await requirePrisma().socialPost.updateMany({
			where: { id: proposalId, ...proposalWhere(scope.workspaceId) },
			data: { status: "cancelled" },
		});
		if (rejected.count === 0) throw new PublishingQueueError("social_proposal_not_found", "This proposal was already accepted or rejected.");
	},

	/** Accepts one proposal into its account's next free slot: the existing
	 * prepare-and-schedule path, so the Brand Profile approval gate, export
	 * freshness and TikTok creator checks all apply. A retry after a lost
	 * response returns the post the first attempt made. */
	async accept(
		scope: ActorScope,
		proposalId: string,
		input: AcceptSocialPostProposalInput = {},
		/** A Standing Grant accepting for a person who isn't there: it is checked, and its caps counted, under the account lock. */
		options: { grant?: PublicationSlotQueue["grant"] } = {},
	): Promise<AcceptedProposal> {
		const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "publishing.manage");
		const prisma = requirePrisma();
		const acceptKey = proposalAcceptKey(proposalId);
		const already = await prisma.socialPost.findUnique({
			where: { workspaceId_clientIdempotencyKey: { workspaceId: scope.workspaceId, clientIdempotencyKey: acceptKey } },
			select: { id: true, projectId: true, clipId: true, platform: true, status: true, scheduledFor: true },
		});
		if (already?.scheduledFor && already.clipId && already.status !== "cancelled") {
			return { socialPostId: already.id, projectId: already.projectId, clipId: already.clipId, platform: already.platform, status: already.status, scheduledFor: already.scheduledFor.toISOString(), replayed: true };
		}
		// Scheduling checks this again with the account; asking first spares the work below.
		requirePlanFeature(actor.pricingTier, "publishing.schedule");
		const row = await prisma.socialPost.findFirst({
			where: { id: proposalId, ...proposalWhere(scope.workspaceId) },
			select: {
				...proposalSelect,
				socialAccount: { select: { status: true, postingSchedule: true } },
				workspace: { select: { timezone: true } },
			},
		});
		if (!row?.proposal || !row.clipId || !row.socialAccountId) throw new PublishingQueueError("social_proposal_not_found", "This proposal was already accepted or rejected.");
		if (row.socialAccount?.status !== "active") throw new PublishingQueueError("social_account_unavailable", "Reconnect this account, then accept the proposal.");
		const schedule = parsePostingSchedule(row.socialAccount.postingSchedule);
		if (!schedule) throw new PublishingQueueError("posting_schedule_missing", "Add posting slots to this account before accepting posts into its queue.");

		const { proposal } = row;
		let deliveryMode: "direct" | "tiktok_inbox" = "direct";
		const providerSettings: Prisma.JsonObject = {};
		if (row.platform === "tiktok") {
			// TikTok needs the creator's own choices on every post, so a person makes them here.
			const choices = input.tiktok;
			if (!choices || (choices.deliveryMode === "direct" && !choices.privacyLevel)) {
				throw new PublishingQueueError("social_proposal_tiktok_options_required", "Choose how this post goes to TikTok, and its visibility, before accepting it.");
			}
			deliveryMode = choices.deliveryMode;
			if (deliveryMode === "direct") {
				Object.assign(providerSettings, {
					tiktokPrivacyLevel: choices.privacyLevel!,
					disableComment: choices.disableComment,
					disableDuet: choices.disableDuet,
					disableStitch: choices.disableStitch,
					isAigc: choices.isAigc,
				});
			}
		} else if (proposal.title && SOCIAL_PROVIDER_CAPABILITIES[row.platform].titleField) {
			providerSettings.title = proposal.title;
		}
		if (deliveryMode === "direct" && !row.caption.trim()) {
			throw new PublishingQueueError("social_proposal_caption_required", "Write a caption for this post before accepting it.");
		}

		const timeZone = row.workspace?.timezone ?? "UTC";
		const variant = proposal.clipExportVariant;
		const intent = await socialPublicationScheduling.schedule({
			actorUserId: scope.actorUserId,
			workspaceId: scope.workspaceId,
			projectId: row.projectId,
			clientIdempotencyKey: acceptKey,
			clipId: row.clipId,
			expectedEditorRevision: variant.export.editorRevision,
			clipExportId: variant.exportId,
			clipExportVariantId: proposal.clipExportVariantId,
			accountId: row.socialAccountId,
			platform: row.platform,
			caption: row.caption,
			aspectRatio: clipAspectRatioFromDb[variant.aspectRatio],
			resolution: variant.resolution as ClipRenderResolution,
			// Placeholder: the queue chooses the slot under the account's lock.
			scheduledFor: new Date(),
			providerSettings,
			deliveryMode,
			assistedCopyVariantId: proposal.assistedCopyVariantId,
			slotQueue: {
				accountId: row.socialAccountId,
				pick: (occupied, after) => nextFreeSlots({ schedule, timeZone, after, occupied }).at(0) ?? null,
				...(options.grant ? { grant: options.grant } : {}),
			},
			proposalId,
		});
		return { socialPostId: intent.id, projectId: intent.projectId, clipId: intent.clipId, platform: intent.frozen.platform, status: intent.status, scheduledFor: intent.frozen.scheduledFor.toISOString(), replayed: false };
	},

	/** Accepts the open proposals, oldest first, each into its own account's next
	 * slot. TikTok proposals are skipped: each needs its creator's choices.
	 * A proposal that can't be accepted is reported and the rest go on. */
	async acceptAll(scope: ActorScope, options: { limit?: number; after?: string | null } = {}) {
		const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "publishing.manage");
		requirePlanFeature(actor.pricingTier, "publishing.schedule");
		const prisma = requirePrisma();
		// A call takes one batch. `after` is the last proposal the previous call tried, so
		// proposals that can't be accepted are not tried again and never starve the rest.
		const cursor = options.after
			? await prisma.socialPost.findFirst({ where: { id: options.after, workspaceId: scope.workspaceId }, select: { createdAt: true, id: true } })
			: null;
		const waiting: Prisma.SocialPostWhereInput = {
			...proposalWhere(scope.workspaceId),
			platform: { not: "tiktok" },
			...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}),
		};
		const [rows, total, skippedTikTok] = await Promise.all([
			prisma.socialPost.findMany({ where: waiting, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: options.limit ?? ACCEPT_ALL_BATCH, select: { id: true } }),
			prisma.socialPost.count({ where: waiting }),
			prisma.socialPost.count({ where: { ...proposalWhere(scope.workspaceId), platform: "tiktok" } }),
		]);
		const accepted: AcceptedProposal[] = [];
		const failed: Array<{ proposalId: string; code: string; message: string }> = [];
		for (const row of rows) {
			try {
				accepted.push(await publishingQueue.accept(scope, row.id));
			} catch (error) {
				if (!(error instanceof ExpectedDomainFailureError)) throw error;
				failed.push({ proposalId: row.id, code: error.code, message: error.message });
			}
		}
		const remaining = Math.max(0, total - rows.length);
		return { accepted, skippedTikTok, failed, remaining, nextCursor: remaining > 0 ? (rows.at(-1)?.id ?? null) : null };
	},

	/** The named accounts that are active and that the Workspace's plan lets publish, for settings that name them. */
	async activeAccounts(workspaceId: string, accountIds: string[]): Promise<Array<{ id: string; platform: SocialPlatform }>> {
		if (accountIds.length === 0) return [];
		const prisma = requirePrisma();
		const [accounts, workspace] = await Promise.all([
			readActiveAccounts(workspaceId, accountIds),
			prisma.workspace.findUnique({ where: { id: workspaceId }, select: { pricingTier: true } }),
		]);
		const { eligible } = await readPublishableSocialAccountIds(prisma, workspaceId, workspace?.pricingTier);
		return accounts.filter((account) => eligible.has(account.id));
	},
};

/** Says why some named accounts can't take queue posts: not active, or not publishable on the plan. */
async function refuseUnusableQueueAccounts(workspaceId: string, accountIds: string[]): Promise<never> {
	const active = await readActiveAccounts(workspaceId, accountIds);
	if (active.length !== new Set(accountIds).size) {
		throw new PublishingQueueError("social_account_unavailable", "Choose connected accounts of this Workspace for the queue. Reconnect or remove any account that's no longer active.");
	}
	const prisma = requirePrisma();
	const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { pricingTier: true } });
	requirePlanFeature(workspace?.pricingTier, "publishing.schedule");
	const { used } = await readPublishableSocialAccountIds(prisma, workspaceId, workspace?.pricingTier);
	throw socialAccountBeyondPlanError(workspace?.pricingTier, used);
}

function readActiveAccounts(workspaceId: string, accountIds: string[]) {
	return requirePrisma().socialAccount.findMany({ where: { id: { in: accountIds }, workspaceId, status: "active" }, select: { id: true, platform: true }, orderBy: { id: "asc" } });
}

/** Finishing and Autopilot name queue accounts in their settings. Refuses the
 * settings when any is not an active account of the Workspace; called when the
 * settings are saved, and again when they run. */
export async function assertQueueAccounts(workspaceId: string, accountIds: readonly string[], aspectRatios?: readonly string[]): Promise<void> {
	if (accountIds.length === 0) return;
	const active = await publishingQueue.activeAccounts(workspaceId, [...accountIds]);
	if (active.length !== new Set(accountIds).size) await refuseUnusableQueueAccounts(workspaceId, [...accountIds]);
	// An export of formats the platform can't take would only fail later, one clip at a time.
	for (const account of active) {
		const accepted: readonly string[] = SOCIAL_PROVIDER_CAPABILITIES[account.platform].aspectRatios;
		if (aspectRatios?.length && !aspectRatios.some((ratio) => accepted.includes(ratio))) {
			throw new PublishingQueueError("finishing_queue_format_unsupported", `${account.platform.replace("_", " ")} takes ${accepted.join(", ")}, and none of the chosen export formats fits. Add one of them.`);
		}
	}
}

/** Finishing that proposes to the queue acts for the person who saved it: they
 * must be able to manage publishing, and every account must be theirs to
 * propose to. Delivery that stops at review asks nothing of publishing. */
export async function assertFinishingQueue(
	scope: ActorScope,
	finishing: { delivery?: string; queueAccountIds?: readonly string[]; aspectRatios?: readonly string[] } | null | undefined,
): Promise<void> {
	if (finishing?.delivery !== "propose_to_queue") return;
	await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "publishing.manage");
	await assertQueueAccounts(scope.workspaceId, finishing.queueAccountIds ?? [], finishing.aspectRatios);
}
