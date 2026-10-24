import type { Prisma } from "@prisma/client";
import { pauseGrantForOutcome } from "./standing-grant";
import { appendWorkspaceEvent } from "./workspace-event";

/** `social_post.finished` Workspace Events. Call this after any write that can
 * settle a Social Post, as the last act of that transaction. It reads the
 * post's resulting status and emits only when that status is a final outcome. */

const FINAL_STATES = {
  posted: "posted",
  inbox_delivered: "sent_to_inbox",
  failed: "failed",
  needs_attention: "needs_attention",
} as const;

/** One event per terminal transition. The attempt's `terminalAt` names the
 * transition: a replay of a settlement or webhook leaves it alone, while an
 * uncertain attempt that is rechecked and settles needs_attention again, or is
 * later confirmed, gets a new one. A post that fails before any attempt exists
 * has no attempt and fails once. */
export async function emitSocialPostFinished(tx: Prisma.TransactionClient, input: { socialPostId: string; attemptId?: string | null }): Promise<void> {
  const post = await tx.socialPost.findUnique({ where: { id: input.socialPostId }, select: { status: true, workspaceId: true, projectId: true, clipId: true, platform: true } });
  const state = post ? FINAL_STATES[post.status as keyof typeof FINAL_STATES] : undefined;
  if (!post?.workspaceId || !state) return;
  // A post a Standing Grant accepted that failed or needs attention pauses that grant. This only
  // queues `grant.paused`, so the flush below writes it beside `social_post.finished`, counter last.
  if (state === "failed" || state === "needs_attention") await pauseGrantForOutcome(tx, { socialPostId: input.socialPostId, state });
  const attempt = input.attemptId ? await tx.socialPublicationAttempt.findUnique({ where: { id: input.attemptId }, select: { terminalAt: true } }) : null;
  await appendWorkspaceEvent(tx, {
    workspaceId: post.workspaceId,
    projectId: post.projectId,
    type: "social_post.finished",
    subject: { socialPostId: input.socialPostId, projectId: post.projectId, clipId: post.clipId, platform: post.platform, state },
    dedupeKey: `social_post.finished:${input.socialPostId}:${input.attemptId ?? "none"}:${state}:${attempt?.terminalAt?.getTime() ?? "none"}`,
  });
}
