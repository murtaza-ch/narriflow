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
  accountId: string;
  platform: SocialPlatform;
  caption: string;
  scheduledLocal: string;
  aspectRatio: ClipAspectRatio;
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
    if (scheduledFor <= new Date()) {
      throw new Error("Choose a future publish time.");
    }
    const post = await socialService.schedulePost(
      appUser.id,
      input.projectId,
      {
        clipId: input.clipId,
        accountId: input.accountId,
        platform: input.platform,
        caption: input.caption,
        scheduledFor: scheduledFor.toISOString(),
        aspectRatio: ratioMap[input.aspectRatio],
      },
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
    );
    revalidatePath("/calendar");
    return { ok: true as const, postId: post.id };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Could not schedule post" };
  }
}

export async function cancelWorkspacePostAction(
  projectId: string,
  postId: string,
) {
  const appUser = await requireWorkspaceAppUser("content.edit");
  await socialService.cancelPost(appUser.id, projectId, postId, {
    workspaceId: appUser.workspaceId,
    actorUserId: appUser.actorUserId,
  });
  revalidatePath("/calendar");
}

export async function retryWorkspacePostAction(postId: string) {
  const appUser = await requireWorkspaceAppUser("publishing.manage");
  await socialService.retryFailedPost(
    appUser.actorUserId,
    appUser.workspaceId,
    postId,
  );
  revalidatePath("/calendar");
}
