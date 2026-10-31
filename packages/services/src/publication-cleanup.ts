import type { PrismaClient } from "@prisma/client";
/** Exact planned inputs and assigned instruction blobs survive uncertain
 * outcomes. Project expiry/purge or explicit resolution releases the hold. */
export async function publicationObjectIsHeld(db: Pick<PrismaClient, "publicationClaim" | "executionArtifact" | "socialPost">, key: string, now = new Date()) {
	const planned =
		/^execution-inputs\/\d+\/publication\/([a-f0-9-]{36})\/\d+\/([a-f0-9-]{36})\.json$/.exec(
			key,
		);
	let postId: string | null = null;
	if (planned) {
		const claim = await db.publicationClaim.findUnique({
			where: { id: planned[2] },
			include: { attempt: { select: { socialPostId: true } } },
		});
		if (
			claim &&
			claim.attempt.socialPostId === planned[1] &&
			(claim.workState as { inputPlan?: { storageKey?: string } } | null)
				?.inputPlan?.storageKey === key
		)
			postId = planned[1]!;
	} else {
		const artifact = await db.executionArtifact.findUnique({
			where: { storageKey: key },
			select: {
				role: true,
				attempt: {
					select: {
						dispatch: { select: { subjectKind: true, subjectId: true } },
					},
				},
			},
		});
		if (
			artifact?.role === "publication_checkpoint" &&
			artifact.attempt.dispatch.subjectKind === "social_publication"
		)
			postId = artifact.attempt.dispatch.subjectId;
	}
	if (!postId) return false;
	const post = await db.socialPost.findUnique({
		where: { id: postId },
		select: {
			status: true,
			project: { select: { purgeStartedAt: true, expiresAt: true } },
		},
	});
	if (
		!post ||
		post.project.purgeStartedAt ||
		(post.project.expiresAt && post.project.expiresAt <= now)
	)
		return false;
	return ![
		"cancelled",
		"failed",
		"posted",
		"inbox_delivered",
		"draft",
	].includes(post.status);
}
