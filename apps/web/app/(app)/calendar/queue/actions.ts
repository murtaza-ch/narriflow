"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { publishingQueue, socialPublishingOptions } from "@narriflow/services";
import {
	acceptSocialPostProposalSchema,
	postingScheduleSchema,
	proposeSocialPostSchema,
	updateSocialPostProposalSchema,
} from "@narriflow/validators";
import { executeWorkspaceActionWithInput } from "@/lib/authenticated-request-action";

const id = z.string().uuid();

function refresh() {
	revalidatePath("/calendar/queue");
	revalidatePath("/calendar");
}

/** Replaces an account's weekly posting slots; null or no slots clears them. */
export async function savePostingScheduleAction(accountId: string, schedule: unknown) {
	return executeWorkspaceActionWithInput(
		"publishing.manage",
		{ accountId, schedule },
		z.strictObject({ accountId: id, schedule: postingScheduleSchema.nullable() }),
		async (actor, input) => {
			await publishingQueue.setPostingSchedule(actor, input.accountId, input.schedule);
			refresh();
		},
	);
}

/** The creator choices TikTok offers this account, for the accept form. */
export async function tiktokAcceptanceOptionsAction(accountId: string) {
	return executeWorkspaceActionWithInput(
		"publishing.manage",
		{ accountId },
		z.strictObject({ accountId: id }),
		async (actor, input) => {
			const options = await socialPublishingOptions(actor, input.accountId);
			return {
				directEnabled: options.directEnabled,
				inboxEnabled: options.inboxEnabled,
				privacyOptions: options.privacyOptions,
				commentDisabled: options.commentDisabled,
				duetDisabled: options.duetDisabled,
				stitchDisabled: options.stitchDisabled,
			};
		},
	);
}

export async function updateProposalCaptionAction(proposalId: string, caption: string) {
	return executeWorkspaceActionWithInput(
		"publishing.manage",
		{ proposalId, caption },
		updateSocialPostProposalSchema.extend({ proposalId: id }),
		async (actor, input) => {
			await publishingQueue.updateProposalCaption(actor, input.proposalId, input.caption);
			refresh();
		},
	);
}

export async function rejectProposalAction(proposalId: string) {
	return executeWorkspaceActionWithInput(
		"publishing.manage",
		{ proposalId },
		z.strictObject({ proposalId: id }),
		async (actor, input) => {
			await publishingQueue.reject(actor, input.proposalId);
			refresh();
		},
	);
}

export async function acceptProposalAction(proposalId: string, choices: unknown) {
	return executeWorkspaceActionWithInput(
		"publishing.manage",
		{ proposalId, choices: choices ?? {} },
		z.strictObject({ proposalId: id, choices: acceptSocialPostProposalSchema }),
		async (actor, input) => {
			const accepted = await publishingQueue.accept(actor, input.proposalId, input.choices);
			refresh();
			return { accepted: [accepted], skippedTikTok: 0, failed: [] };
		},
	);
}

/** Accepts one batch of open proposals except TikTok's, oldest first; each of those needs its
 * creator's choices. The caller continues from `nextCursor` until it comes back null. */
export async function acceptAllProposalsAction(after: string | null = null) {
	return executeWorkspaceActionWithInput("publishing.manage", { after }, z.strictObject({ after: id.nullable() }), async (actor, input) => {
		const result = await publishingQueue.acceptAll(actor, { after: input.after });
		refresh();
		return result;
	});
}

/** A person proposes a clip's export to an account's queue, from the publishing drawer. */
export async function proposeToQueueAction(input: unknown) {
	return executeWorkspaceActionWithInput(
		"publishing.manage",
		input,
		proposeSocialPostSchema.extend({ idempotencyKey: id }),
		async (actor, parsed) => {
			const { idempotencyKey, ...proposal } = parsed;
			const result = await publishingQueue.propose(actor, proposal, { source: "person", mutation: { clientIdempotencyKey: idempotencyKey } });
			refresh();
			return { proposalId: result.proposal.proposalId };
		},
	);
}
