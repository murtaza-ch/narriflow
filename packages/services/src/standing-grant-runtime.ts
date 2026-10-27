import { getPrismaClient } from "@narriflow/db/client";
import { resolvePricingTier, type FinishingReason } from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { publishingQueue } from "./publishing-queue.service";
import { brandApprovalRequiredByDefault, reviewDeliverySecret, reviewService } from "./review.service";
import { PlanRequirementError } from "./plan-features";
import { createReviewerOptOut, optedOutReviewers } from "./review-opt-out";
import {
  createStandingGrants,
  findCoveringGrant,
  grantAdmission,
  planCoversGrant,
  StandingGrantError,
  type GrantNoticeResult,
  type GrantPausedNotice,
  type StandingGrants,
} from "./standing-grant";
import { workspaceService } from "./workspace.service";

function requiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

const requireActor = (userId: string, workspaceId: string, capability: Parameters<typeof workspaceService.requireActor>[2]) =>
  workspaceService.requireActor(userId, workspaceId, capability);

let grants: StandingGrants | null = null;
const service = () => (grants ??= createStandingGrants({ prisma: requiredPrisma(), requireActor }));

/** Production management of Standing Grants on the shared database. */
export const standingGrants = {
  list: (actor: ActorScope) => service().list(actor),
  create: (actor: ActorScope, input: Parameters<StandingGrants["create"]>[1]) => service().create(actor, input),
  renew: (actor: ActorScope, input: Parameters<StandingGrants["renew"]>[1]) => service().renew(actor, input),
  pause: (actor: ActorScope, grantId: string) => service().pause(actor, grantId),
  revoke: (actor: ActorScope, grantId: string) => service().revoke(actor, grantId),
};

let optOut: ReturnType<typeof createReviewerOptOut> | null = null;
const reviewerOptOutService = () => (optOut ??= createReviewerOptOut({ prisma: requiredPrisma(), secret: reviewDeliverySecret }));

/** A reviewer's opt-out from automated review requests, by the signed link in the email. */
export const reviewerOptOut = {
  preview: (token: string) => reviewerOptOutService().preview(token),
  confirm: (token: string) => reviewerOptOutService().confirm(token),
};

/** Emails the person who should hear that a grant paused itself. Uses the configured email provider. */
async function emailPausedNotice(appBaseUrl: string | null, notice: GrantPausedNotice): Promise<GrantNoticeResult> {
  if (!appBaseUrl) return { sent: false, reason: "app_base_url_missing" };
  const email = await import("@narriflow/email/worker");
  const template = email.standingGrantPaused({
    ruleName: notice.ruleName,
    destination: notice.destination,
    reason: notice.reason,
    settingsLink: new URL("/settings/automation-grants", appBaseUrl).toString(),
  });
  const result = await email.sendEmail({ to: notice.to, ...template, idempotencyKey: notice.idempotencyKey });
  if (result.sent) return { sent: true };
  if (result.error) throw new Error("Email provider refused the grant notice");
  return { sent: false, reason: result.reason ?? "email_not_sent" };
}

let maintenance: StandingGrants | null = null;

/** The worker's side: the expiry sweep, and the emails for grants that paused themselves. */
export function getStandingGrantMaintenance(appBaseUrl: () => string | null) {
  maintenance ??= createStandingGrants({
    prisma: requiredPrisma(),
    requireActor,
    notifyPaused: (notice) => emailPausedNotice(appBaseUrl(), notice),
  });
  return maintenance;
}

/** What happened to a proposal a publish grant was asked to accept. `accepted`
 * is the only outcome that takes a slot; any other leaves it a proposal for a
 * person, and says why. */
export type GrantAcceptOutcome = "accepted" | "no_grant" | "tiktok_excluded" | "not_a_proposal" | "granter_unavailable" | (string & {});

/** Accepts a just-made proposal under the publish grant that covers its rule and
 * account, if one does. It is the ordinary accept path, run for the granter: the
 * export freshness checks and the Brand Profile approval gate apply as they
 * would for a person, and no override is ever passed, so an `approval_required`
 * brand without an approved round keeps its proposal. The cap check and the slot
 * are taken in one transaction under the account's lock. A refusal is an
 * outcome, not an error. */
export async function acceptProposalUnderGrant(input: { finishingId: string; workspaceId: string; projectId: string; proposalId: string }): Promise<GrantAcceptOutcome> {
  const prisma = requiredPrisma();
  const post = await prisma.socialPost.findFirst({
    where: { id: input.proposalId, workspaceId: input.workspaceId, projectId: input.projectId, proposal: { isNot: null } },
    select: { status: true, platform: true, socialAccountId: true, standingGrantId: true },
  });
  if (!post?.socialAccountId) return "not_a_proposal";
  // A repeat after a crash finds the post the first run accepted.
  if (post.standingGrantId) return "accepted";
  if (post.status !== "draft") return "not_a_proposal";
  // TikTok needs the creator's choices on every post, so a person always accepts its proposals.
  if (post.platform === "tiktok") return "tiktok_excluded";

  const grant = await findCoveringGrant(prisma, { workspaceId: input.workspaceId, finishingId: input.finishingId, kind: "publish", socialAccountId: post.socialAccountId });
  if (!grant) return "no_grant";
  // The grant acts for its granter, who must still be an Owner or Admin.
  const granter = grant.grantedByUserId;
  const granterActor = granter ? await requireActor(granter, input.workspaceId, "workspace.manage").catch((error) => {
    if (error instanceof ExpectedDomainFailureError) return null;
    throw error;
  }) : null;
  if (!granter || !granterActor) {
    await service().pauseBySystem(grant.id, "granter_unavailable", grant.revision);
    return "granter_unavailable";
  }
  if (!planCoversGrant(granterActor.pricingTier, "publish")) {
    await service().pauseBySystem(grant.id, "plan_lost", grant.revision);
    return "plan_lost";
  }
  try {
    await publishingQueue.accept({ actorUserId: granter, workspaceId: input.workspaceId }, input.proposalId, {}, { grant: grantAdmission(grant.id, "publish") });
    return "accepted";
  } catch (error) {
    // The delivery's transaction rolled back with this error, so the pause is its own.
    if (error instanceof StandingGrantError && error.code === "standing_grant_rule_changed") {
      await service().pauseBySystem(grant.id, "rule_changed", grant.revision);
    }
    // The account is beyond the plan's count, or the plan lost a feature: pause rather than retry each run.
    if (error instanceof PlanRequirementError) await service().pauseBySystem(grant.id, "plan_lost", grant.revision);
    if (error instanceof ExpectedDomainFailureError) return error.code;
    throw error;
  }
}

/** Sends a finished generation's exports to the reviewers of the review-send grant
 * that covers its rule, as one Review Round through the existing review service.
 * One round per finishing: the round carries the finishing's ID, which is unique,
 * so a re-claim or a second worker finds it. A refusal says why, and finishing
 * ends with the reason instead of failing. */
export async function sendReviewRoundUnderGrant(input: { finishingId: string; workspaceId: string; projectId: string; exportIds: string[] }): Promise<{ sent: true } | { sent: false; reason: FinishingReason }> {
  const prisma = requiredPrisma();
  const sent = await prisma.reviewRound.findUnique({ where: { finishingId: input.finishingId }, select: { id: true } });
  if (sent) return { sent: true };

  const grant = await findCoveringGrant(prisma, { workspaceId: input.workspaceId, finishingId: input.finishingId, kind: "review_send" });
  if (!grant) return { sent: false, reason: "review_not_sent_no_grant" };
  const granter = grant.grantedByUserId;
  const actor = granter ? await requireActor(granter, input.workspaceId, "workspace.manage").catch((error) => {
    if (error instanceof ExpectedDomainFailureError) return null;
    throw error;
  }) : null;
  if (!granter || !actor) {
    await service().pauseBySystem(grant.id, "granter_unavailable", grant.revision);
    return { sent: false, reason: "review_not_sent_granter" };
  }
  if (!planCoversGrant(actor.pricingTier, "review_send")) {
    // Paused, so a later upgrade doesn't resume automatic client sends without a renewal.
    await service().pauseBySystem(grant.id, "plan_lost", grant.revision);
    return { sent: false, reason: "review_not_sent_plan" };
  }

  const [project, exports] = await Promise.all([
    prisma.project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, select: { title: true, brandProfileSnapshot: true } }),
    prisma.clipExport.findMany({
      where: { id: { in: input.exportIds }, projectId: input.projectId, status: "ready" },
      orderBy: { createdAt: "asc" },
      select: { id: true, clipId: true, editorRevision: true, variants: { where: { status: "completed" }, orderBy: { createdAt: "asc" }, select: { id: true } } },
    }),
  ]);
  const items = exports.filter((entry) => entry.variants.length > 0).map((entry) => ({
    clipId: entry.clipId,
    exportId: entry.id,
    expectedEditorRevision: entry.editorRevision,
    variantIds: entry.variants.slice(0, 4).map((variant) => variant.id),
    required: true,
  }));
  if (!project || items.length === 0) return { sent: false, reason: "no_clips" };
  // A reviewer who asked to stop automated review requests from this Workspace is not asked again.
  const named = Array.isArray(grant.reviewerEmails) ? grant.reviewerEmails.filter((entry): entry is string => typeof entry === "string") : [];
  const declined = await optedOutReviewers(prisma, input.workspaceId, named);
  const recipients = named.filter((email) => !declined.has(email.trim().toLowerCase()));
  if (recipients.length === 0) return { sent: false, reason: "review_not_sent_opted_out" };

  try {
    await reviewService.createRound(
      { actorUserId: granter, workspaceId: input.workspaceId, projectId: input.projectId, pricingTier: resolvePricingTier(actor.pricingTier) },
      {
        title: `${project.title} clips for review`.slice(0, 160),
        // The Brand Profile's own rule decides whether the reviewers' approval is required.
        approvalRequired: brandApprovalRequiredByDefault(project.brandProfileSnapshot),
        recipientEmails: recipients,
        items,
      },
      { grant: grantAdmission(grant.id, "review_send"), finishingId: input.finishingId },
    );
    return { sent: true };
  } catch (error) {
    // Another worker may have sent this finishing's round between our check and our insert.
    // Whatever stopped us then, the round exists, which is what finishing wants.
    if (await prisma.reviewRound.findUnique({ where: { finishingId: input.finishingId }, select: { id: true } })) return { sent: true };
    if (error instanceof StandingGrantError) {
      if (error.code === "standing_grant_rule_changed") {
        await service().pauseBySystem(grant.id, "rule_changed", grant.revision);
        return { sent: false, reason: "review_not_sent_changed" };
      }
      return { sent: false, reason: error.code === "standing_grant_cap_reached" ? "review_not_sent_cap" : "review_not_sent_no_grant" };
    }
    // A clip edited since its export, say: not worth failing finishing for. A person sends the round.
    if (error instanceof ExpectedDomainFailureError) return { sent: false, reason: "review_not_sent_failed" };
    throw error;
  }
}
