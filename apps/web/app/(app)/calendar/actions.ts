"use server";

import { revalidatePath } from "next/cache";
import { socialService } from "@narriflow/services";
import { executeProjectAction } from "@/lib/authenticated-request-action";

export async function cancelWorkspacePostAction(
	projectId: string,
	postId: string,
) {
	return executeProjectAction(
		projectId,
		"publishing.manage",
		async (appUser) => {
			await socialService.cancelPost(appUser, projectId, postId);
			revalidatePath("/calendar");
		},
	);
}
