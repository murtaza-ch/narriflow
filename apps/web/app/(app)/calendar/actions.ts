"use server";

import { revalidatePath } from "next/cache";
import {
	socialService,
	workspaceLocalDateTimeToUtc,
	workspaceService,
} from "@narriflow/services";
import type { ClipAspectRatio, SocialPlatform } from "@prisma/client";
import { requireWorkspaceAppUser } from "@/lib/workspace";

const ratioMap: Record<ClipAspectRatio, "9:16" | "1:1" | "16:9" | "4:5"> = {
	ratio_9_16: "9:16",
	ratio_1_1: "1:1",
	ratio_16_9: "16:9",
	ratio_4_5: "4:5",
};

export async function scheduleWorkspacePostAction(input: {
	projectId: string;
	clipId: string;
	clientIdempotencyKey: string;
	expectedEditorRevision: number;
	accountId: string;
	platform: SocialPlatform;
	caption: string;
	scheduledLocal: string;
	aspectRatio: ClipAspectRatio;
	resolution: "720p" | "1080p";
}) {
	try {
		const appUser = await requireWorkspaceAppUser("publishing.manage");
		const workspace = await workspaceService.getWorkspace(
			appUser.actorUserId,
			appUser.workspaceId,
		);
		const scheduledFor = workspaceLocalDateTimeToUtc(
			input.scheduledLocal,
			workspace?.timezone ?? "UTC",
		);
		const post = await socialService.schedulePost(
			appUser.id,
			input.projectId,
			{
				clientIdempotencyKey: input.clientIdempotencyKey,
				clipId: input.clipId,
				expectedEditorRevision: input.expectedEditorRevision,
				accountId: input.accountId,
				platform: input.platform,
				caption: input.caption,
				scheduledFor: scheduledFor.toISOString(),
				aspectRatio: ratioMap[input.aspectRatio],
				resolution: input.resolution,
				providerSettings: {},
			},
			{ workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
		);
		revalidatePath("/calendar");
		return { ok: true as const, postId: post.id };
	} catch (error) {
		return {
			ok: false as const,
			error: error instanceof Error ? error.message : "Could not schedule post",
		};
	}
}

export async function cancelWorkspacePostAction(
	projectId: string,
	postId: string,
) {
	const appUser = await requireWorkspaceAppUser("content.edit");
	await socialService.cancelPost(projectId, postId, {
		workspaceId: appUser.workspaceId,
		actorUserId: appUser.actorUserId,
	});
	revalidatePath("/calendar");
}
