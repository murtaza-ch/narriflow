"use server";

import { revalidatePath } from "next/cache";
import {
	socialService,
	workspaceLocalDateTimeToUtc,
	workspaceService,
} from "@narriflow/services";
import type { ClipAspectRatio, SocialPlatform } from "@prisma/client";
import {
	executeProjectAction,
	authenticatedActionResultError,
} from "@/lib/authenticated-request-action";

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
	approvalOverrideReason?: string | null;
}) {
	try {
		return await executeProjectAction(
			input.projectId,
			"publishing.manage",
			async (appUser) => {
			try {
		const workspace = await workspaceService.getWorkspace(
			appUser.actorUserId,
			appUser.workspaceId,
		);
		const scheduledFor = workspaceLocalDateTimeToUtc(
			input.scheduledLocal,
			workspace?.timezone ?? "UTC",
		);
		const post = await socialService.schedulePost(
			appUser.workspaceOwnerUserId,
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
				approvalOverrideReason: input.approvalOverrideReason?.trim() || null,
			},
			{ workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
		);
		revalidatePath("/calendar");
		return { ok: true as const, postId: post.id };
			} catch (error) {
    const failure = authenticatedActionResultError(
      error,
      "Could not schedule post",
    );
		return {
			ok: false as const,
			error: failure.message,
      errorCode: failure.errorCode,
      requestId: failure.requestId,
		};
			}
		},
		);
	} catch (error) {
    const failure = authenticatedActionResultError(
      error,
      "Could not schedule post",
    );
		return {
			ok: false as const,
			error: failure.message,
      errorCode: failure.errorCode,
      requestId: failure.requestId,
		};
	}
}

export async function cancelWorkspacePostAction(
	projectId: string,
	postId: string,
) {
	return executeProjectAction(
		projectId,
		"publishing.manage",
		async (appUser) => {
			await socialService.cancelPost(projectId, postId, {
				workspaceId: appUser.workspaceId,
				actorUserId: appUser.actorUserId,
			});
			revalidatePath("/calendar");
		},
	);
}
