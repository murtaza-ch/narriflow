import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createStandingGrantSchema,
  renewStandingGrantSchema,
  standingGrantPauseMessage,
  type CreateStandingGrantInput,
  type RenewStandingGrantInput,
  type StandingGrantKind,
  type StandingGrantPauseReason,
  type StandingGrantView,
  type WorkspaceCapability,
} from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import { ExpectedDomainFailureError, type ExpectedDomainFailureCatalog } from "./expected-domain-failure";
import { hasFeature, requirePlanFeature } from "./plan-features";
import { requirePublishableSocialAccount } from "./social-account-eligibility";
import { optedOutReviewers } from "./review-opt-out";
import { flushWorkspaceEvents, queueWorkspaceEvent } from "./workspace-event";

/** Standing Grants: authority an Owner or Admin gives one Autopilot rule's
 * output to go out without a click. See `StandingGrant` in the schema.
 *
 * Two kinds of function live here. The management API (create, renew, pause,
 * revoke, list) is what Settings calls, and needs `workspace.manage`, which
 * only Owners and Admins hold. The transaction helpers (`grantAdmission`,
 * `pauseGrantForOutcome`, and the ones other services call when a rule, an
 * account or a member changes) run inside the transactions that use a grant:
 * they lock the grant's row, so a renewal, pause or revocation can't slip
 * between the check and the delivery it allows. A grant never weakens a Brand
 * Profile's approval rule; it only supplies the click the rule has no opinion
 * on.
 *
 * Lock order is rule, then grant, then the Workspace Event counter (last). */

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** A skipped pause notice (emails off, no app URL) is tried again after this long. */
const NOTICE_RETRY_MS = 5 * 60_000;
/** A worker holds a notice this long; one that never settles is tried again after it. */
const NOTICE_LEASE_MS = 5 * 60_000;
const HISTORY_EVENTS = 12;
const HISTORY_SENT = 5;
const MAX_LISTED_GRANTS = 100;
const RETURN_BATCH = 100;

const failures = {
  standing_grant_account_unavailable: "missing",
  standing_grant_cap_reached: "conflict",
  standing_grant_closed: "conflict",
  standing_grant_duplicate: "conflict",
  standing_grant_not_active: "conflict",
  standing_grant_not_found: "missing",
  standing_grant_rule_changed: "conflict",
  standing_grant_rule_not_found: "missing",
  standing_grant_tiktok_excluded: "invalid",
  standing_grant_unavailable: "conflict",
} as const satisfies ExpectedDomainFailureCatalog<string>;

/** Publish grants come with Finishing and publishing; review-send grants with Review Rooms. */
function requireGrantPlan(tier: string, kind: "publish" | "review_send") {
  if (kind === "publish") {
    requirePlanFeature(tier, "campaign.operations");
    requirePlanFeature(tier, "publishing.schedule");
  } else requirePlanFeature(tier, "review.rooms");
}

/** Whether the plan still covers a grant of this kind. A grant it doesn't pauses with
 * `plan_lost`, and only a renewal, which checks the plan again, turns it back on. */
export function planCoversGrant(tier: string | null | undefined, kind: StandingGrantKind) {
  return kind === "publish"
    ? hasFeature(tier, "campaign.operations") && hasFeature(tier, "publishing.schedule")
    : hasFeature(tier, "review.rooms");
}

export class StandingGrantError extends ExpectedDomainFailureError<keyof typeof failures> {
  constructor(code: keyof typeof failures, message: string) {
    super({ code, kind: failures[code], message });
    this.name = "StandingGrantError";
  }
}

/** Reviewer addresses as a round stores them: trimmed, lower case, unique, sorted. */
export function normalizeReviewerEmails(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
}

/** The name people see for a user: their name, else their email. */
function personName(user: { firstName: string | null; lastName: string | null; primaryEmail: string | null }): string | null {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.primaryEmail;
}

function emailsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A hash of everything about a rule that decides what its output is and who may
 * see it. The rule itself contributes where it reads from (feed URL) and its title
 * prefix. Its Recipe contributes the Recipe's identity and content revision, which
 * stands for the language, Content Pack and Finishing settings, and the Brand
 * Profile the Recipe resolves to with that profile's approval rule and deleted
 * flag. Names do not count: renaming the rule or the Recipe changes nothing, and
 * the Recipe's content revision (unlike its edit revision) does not move on a rename.
 *
 * A grant stores it when it is made or renewed; a rule that no longer matches
 * pauses the grant until a person renews it. Null when the rule is gone. */
export async function ruleFingerprint(db: Pick<Tx, "autopilotRule">, ruleId: string): Promise<string | null> {
  const rule = await db.autopilotRule.findUnique({
    where: { id: ruleId },
    select: {
      sourceKind: true,
      rssUrl: true,
      zoomConnectionId: true,
      zoomTopicFilter: true,
      zoomConnection: { select: { revokedAt: true } },
      titlePrefix: true,
      recipeId: true,
      recipe: {
        select: {
          contentRevision: true,
          brandProfileId: true,
          brandProfile: { select: { approvalRule: true, deletedAt: true } },
        },
      },
    },
  });
  if (!rule) return null;
  return createHash("sha256").update(canonicalJson({
    contract: "standing-grant-rule-v3",
    sourceKind: rule.sourceKind,
    zoomConnectionId: rule.zoomConnectionId,
    zoomTopicFilter: rule.zoomTopicFilter,
    zoomRevoked: Boolean(rule.zoomConnection?.revokedAt),
    rssUrl: rule.rssUrl,
    titlePrefix: rule.titlePrefix,
    recipeId: rule.recipeId,
    recipeContentRevision: rule.recipe.contentRevision,
    brandProfileId: rule.recipe.brandProfileId,
    approvalRule: rule.recipe.brandProfile?.approvalRule ?? null,
    brandProfileDeleted: Boolean(rule.recipe.brandProfile?.deletedAt),
  })).digest("hex");
}

// --- Transaction helpers ----------------------------------------------------

/** How many deliveries a grant has made in the last 24 hours and 7 days: posts
 * it accepted, or rounds it sent. */
export async function grantUsage(
  db: Pick<Tx, "socialPost" | "reviewRound">,
  grant: { id: string; kind: StandingGrantKind },
  now: Date,
): Promise<{ day: number; week: number }> {
  const since = (ms: number) => new Date(now.getTime() - ms);
  const count = (from: Date) => grant.kind === "publish"
    ? db.socialPost.count({ where: { standingGrantId: grant.id, proposal: { acceptedAt: { gte: from } } } })
    : db.reviewRound.count({ where: { standingGrantId: grant.id, createdAt: { gte: from } } });
  const day = await count(since(DAY_MS));
  const week = await count(since(WEEK_MS));
  return { day, week };
}

/** What a delivery under a grant runs inside its own transaction: locks the
 * grant's row (the write is a no-op touch that fails the delivery if the grant
 * is no longer active and unexpired), checks the rule still matches what the
 * grant was made for, then counts the caps. The caller holds the lock that
 * serializes deliveries of this grant: the Social Account's row for a post, the
 * grant's row itself for a round. Returns the revision the delivery runs under,
 * which it records as its evidence.
 *
 * A rule that changed throws `standing_grant_rule_changed`. The delivery's
 * transaction rolls back with it, so the caller pauses the grant afterwards
 * (`pauseBySystem(..., "rule_changed")`); the next delivery then finds it paused. */
export function grantAdmission(grantId: string, kind: StandingGrantKind, now: () => Date = () => new Date()) {
  return {
    id: grantId,
    async admit(tx: Tx): Promise<{ revision: number }> {
      const at = now();
      const live = await tx.standingGrant.updateMany({
        where: { id: grantId, kind, status: "active", expiresAt: { gt: at } },
        data: { updatedAt: at },
      });
      if (live.count !== 1) throw new StandingGrantError("standing_grant_unavailable", "The standing grant is no longer active.");
      const grant = await tx.standingGrant.findUniqueOrThrow({
        where: { id: grantId },
        select: { revision: true, dailyCap: true, weeklyCap: true, autopilotRuleId: true, ruleFingerprint: true },
      });
      const current = grant.autopilotRuleId ? await ruleFingerprint(tx, grant.autopilotRuleId) : null;
      if (current !== grant.ruleFingerprint) {
        throw new StandingGrantError("standing_grant_rule_changed", "The Autopilot rule changed after this was granted. Renew the grant to approve the new settings.");
      }
      const used = await grantUsage(tx, { id: grantId, kind }, at);
      if (used.day >= grant.dailyCap || used.week >= grant.weeklyCap) {
        throw new StandingGrantError("standing_grant_cap_reached", used.day >= grant.dailyCap
          ? `The standing grant's daily cap of ${grant.dailyCap} is reached.`
          : `The standing grant's weekly cap of ${grant.weeklyCap} is reached.`);
      }
      return { revision: grant.revision };
    },
  };
}

/** Pauses an active grant. Queues `grant.paused` for the caller's flush, and
 * does nothing when the grant is not active (or, with `revision`, not at that
 * revision). Returns whether it paused. */
async function pauseInTransaction(
  tx: Tx,
  input: { grantId: string; reason: StandingGrantPauseReason; actorUserId: string | null; revision?: number },
): Promise<boolean> {
  const paused = await tx.standingGrant.updateMany({
    where: { id: input.grantId, status: "active", ...(input.revision === undefined ? {} : { revision: input.revision }) },
    // A pause the system made is emailed to the granter once; a person already knows.
    data: { status: "paused", pausedReason: input.reason, pauseNoticePending: input.actorUserId === null, pauseNoticeLeaseUntil: null },
  });
  if (paused.count !== 1) return false;
  const grant = await tx.standingGrant.findUniqueOrThrow({
    where: { id: input.grantId },
    select: { workspaceId: true, kind: true, autopilotRuleId: true, revision: true },
  });
  await tx.standingGrantEvent.create({
    data: { grantId: input.grantId, kind: "paused", revision: grant.revision, actorUserId: input.actorUserId, reason: input.reason },
  });
  // One pause per revision: only an active grant pauses, and renewing starts a new revision.
  queueWorkspaceEvent(tx, {
    workspaceId: grant.workspaceId,
    projectId: null,
    type: "grant.paused",
    subject: { grantId: input.grantId, kind: grant.kind, autopilotRuleId: grant.autopilotRuleId, reason: input.reason },
    dedupeKey: `grant.paused:${input.grantId}:${grant.revision}`,
  });
  return true;
}

/** The hook where `social_post.finished` is derived: a post a grant accepted
 * that ended `failed` or `needs_attention` pauses that grant, in the same
 * transaction. It only queues the `grant.paused` event; the caller flushes.
 * A post accepted under an earlier revision doesn't pause a renewed grant. */
export async function pauseGrantForOutcome(tx: Tx, input: { socialPostId: string; state: "failed" | "needs_attention" }): Promise<void> {
  const post = await tx.socialPost.findUnique({ where: { id: input.socialPostId }, select: { standingGrantId: true, standingGrantRevision: true } });
  if (!post?.standingGrantId || post.standingGrantRevision === null) return;
  await pauseInTransaction(tx, {
    grantId: post.standingGrantId,
    revision: post.standingGrantRevision,
    reason: input.state === "failed" ? "post_failed" : "post_needs_attention",
    actorUserId: null,
  });
}

/** Pauses the active grants a person granted, for when they are demoted below
 * Owner or Admin or removed from the Workspace. Call it in the transaction that
 * changes the membership, and end that transaction with `flushWorkspaceEvents`. */
export async function pauseGrantsOfGranter(tx: Tx, input: { workspaceId: string; userId: string }): Promise<number> {
  const grants = await tx.standingGrant.findMany({
    where: { workspaceId: input.workspaceId, grantedByUserId: input.userId, status: "active" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  let paused = 0;
  for (const { id } of grants) {
    if (await pauseInTransaction(tx, { grantId: id, reason: "granter_unavailable", actorUserId: null })) paused += 1;
  }
  return paused;
}

/** Pauses the active grants of a rule whose content no longer matches what they
 * were made for. Call it in the transaction that edits the rule, then flush. */
export async function pauseGrantsWhoseRuleChanged(tx: Tx, ruleId: string): Promise<number> {
  // The caller holds the rule's row (it just wrote it, or locked it); grants come after.
  const grants = await tx.standingGrant.findMany({
    where: { autopilotRuleId: ruleId, status: "active" },
    select: { id: true, ruleFingerprint: true },
    orderBy: { id: "asc" },
  });
  if (grants.length === 0) return 0;
  const current = await ruleFingerprint(tx, ruleId);
  let paused = 0;
  for (const grant of grants) {
    if (grant.ruleFingerprint !== current && await pauseInTransaction(tx, { grantId: grant.id, reason: "rule_changed", actorUserId: null })) paused += 1;
  }
  return paused;
}

/** Revokes the live grants of a rule or an account that is going away, keeping each
 * grant and its audit trail. The rule's or account's row is deleted or disconnected
 * by the caller, in the same transaction, after taking its own lock. */
export async function revokeGrantsInTransaction(
  tx: Tx,
  where: { autopilotRuleId: string } | { socialAccountId: string },
  reason: "rule_deleted" | "account_disconnected",
): Promise<number> {
  const grants = await tx.standingGrant.findMany({
    where: { ...where, status: { in: ["active", "paused", "expired"] } },
    select: { id: true, revision: true },
    orderBy: { id: "asc" },
  });
  for (const grant of grants) {
    await tx.standingGrant.update({ where: { id: grant.id }, data: { status: "revoked", pauseNoticePending: false, pauseNoticeLeaseUntil: null } });
    await tx.standingGrantEvent.create({ data: { grantId: grant.id, kind: "revoked", revision: grant.revision, actorUserId: null, reason } });
  }
  return grants.length;
}

/** Gives the posts of grants that ended (revoked or expired) back to the proposal
 * inbox, unless the publisher already took them. A post that has no attempt yet is
 * only a scheduled slot, so it reverts cleanly in place: it becomes the draft it
 * was, with no time and no frozen state, and a person can accept it again. A post
 * the publisher is working on is left to finish, because an attempt that has begun
 * can't be taken back. Returns how many were returned. */
export async function returnGrantPosts(prisma: PrismaClient, input: { limit?: number } = {}): Promise<number> {
  const waiting = await prisma.$queryRaw<Array<{ grantId: string }>>`
    SELECT DISTINCT p."standingGrantId" AS "grantId"
    FROM "SocialPost" p JOIN "StandingGrant" g ON g."id" = p."standingGrantId"
    WHERE g."status" IN ('revoked', 'expired') AND p."status" IN ('scheduled', 'preparing_video')
      AND NOT EXISTS (SELECT 1 FROM "SocialPublicationAttempt" a WHERE a."socialPostId" = p."id")
    LIMIT 50
  `;
  let returned = 0;
  for (const { grantId } of waiting) {
    returned += await prisma.$transaction(async (tx) => {
      // The publisher claims a post under the post's own lock, so skipping a locked row is safe: it is being claimed.
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT p."id" FROM "SocialPost" p
        WHERE p."standingGrantId" = ${grantId}::uuid AND p."status" IN ('scheduled', 'preparing_video')
          AND NOT EXISTS (SELECT 1 FROM "SocialPublicationAttempt" a WHERE a."socialPostId" = p."id")
        ORDER BY p."id" LIMIT ${input.limit ?? RETURN_BATCH}
        FOR UPDATE OF p SKIP LOCKED
      `;
      if (rows.length === 0) return 0;
      const ids = rows.map((row) => row.id);
      const grant = await tx.standingGrant.findUniqueOrThrow({ where: { id: grantId }, select: { revision: true, status: true } });
      await tx.frozenPublicationState.deleteMany({ where: { socialPostId: { in: ids } } });
      await tx.socialPost.updateMany({
        where: { id: { in: ids } },
        data: { status: "draft", scheduledFor: null, nextAttemptAt: null, standingGrantId: null, standingGrantRevision: null },
      });
      await tx.socialPostProposal.updateMany({ where: { socialPostId: { in: ids } }, data: { acceptedAt: null, acceptedByUserId: null } });
      await tx.standingGrantEvent.create({
        data: {
          grantId, kind: "returned", revision: grant.revision, actorUserId: null,
          reason: `${ids.length} scheduled post${ids.length === 1 ? "" : "s"} returned to the proposal inbox because the grant ${grant.status === "expired" ? "expired" : "was revoked"}`,
        },
      });
      return ids.length;
    });
  }
  return returned;
}

/** The active grant of a kind that covers a finishing, if any. A finishing is covered
 * by the rule that froze it: the Autopilot import records its rule on the finishing,
 * and nothing else does, so settings a request passes for a rule's Project are never
 * covered by that rule's grants. */
export async function findCoveringGrant(
  db: Pick<PrismaClient, "generationFinishing" | "standingGrant">,
  input: { workspaceId: string; finishingId: string; kind: StandingGrantKind; socialAccountId?: string; now?: Date },
) {
  const finishing = await db.generationFinishing.findFirst({
    where: { id: input.finishingId, workspaceId: input.workspaceId },
    select: { autopilotRuleId: true },
  });
  if (!finishing?.autopilotRuleId) return null;
  return db.standingGrant.findFirst({
    where: {
      workspaceId: input.workspaceId,
      autopilotRuleId: finishing.autopilotRuleId,
      kind: input.kind,
      status: "active",
      expiresAt: { gt: input.now ?? new Date() },
      ...(input.socialAccountId ? { socialAccountId: input.socialAccountId } : {}),
    },
    select: { id: true, kind: true, revision: true, grantedByUserId: true, reviewerEmails: true },
  });
}

// --- Management --------------------------------------------------------------

export interface GrantPausedNotice {
  to: string;
  grantId: string;
  ruleName: string;
  destination: string;
  reason: string;
  /** Names the grant and revision, so a send that is repeated reaches the inbox once. */
  idempotencyKey: string;
}
export type GrantNoticeResult = { sent: true } | { sent: false; reason: string };

export interface StandingGrantDependencies {
  prisma: PrismaClient;
  requireActor(userId: string, workspaceId: string, capability: WorkspaceCapability): Promise<{ pricingTier: string }>;
  now?: () => Date;
  /** Emails the person who should hear that a grant paused itself. */
  notifyPaused?: (notice: GrantPausedNotice) => Promise<GrantNoticeResult>;
  log?: (entry: Record<string, unknown>) => void;
}

export function createStandingGrants(deps: StandingGrantDependencies) {
  const { prisma } = deps;
  const now = () => deps.now?.() ?? new Date();
  const log = deps.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  let noticesPausedUntil = 0;

  /** Pauses active grants whose Workspace's plan no longer covers their kind. */
  async function pauseBeyondPlan(limit: number): Promise<number> {
    const active = await prisma.standingGrant.findMany({
      where: { status: "active" },
      orderBy: { id: "asc" },
      take: limit * 10,
      select: { id: true, kind: true, revision: true, workspace: { select: { pricingTier: true } } },
    });
    let paused = 0;
    for (const grant of active) {
      if (planCoversGrant(grant.workspace.pricingTier, grant.kind)) continue;
      const done = await prisma.$transaction(async (tx) => {
        const changed = await pauseInTransaction(tx, { grantId: grant.id, reason: "plan_lost", actorUserId: null, revision: grant.revision });
        await flushWorkspaceEvents(tx);
        return changed;
      });
      if (done) paused += 1;
    }
    return paused;
  }

  async function requireGrantManager(scope: ActorScope) {
    return deps.requireActor(scope.actorUserId, scope.workspaceId, "workspace.manage");
  }

  /** The rule's row, locked for the rest of the transaction. */
  async function lockRule(tx: Tx, workspaceId: string, ruleId: string) {
    const [rule] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "AutopilotRule" WHERE "id" = ${ruleId}::uuid AND "workspaceId" = ${workspaceId}::uuid FOR NO KEY UPDATE`;
    return rule ?? null;
  }

  /** The grant's row, locked for the rest of the transaction. */
  async function lockGrant(tx: Tx, workspaceId: string, grantId: string) {
    await tx.$queryRaw`SELECT "id" FROM "StandingGrant" WHERE "id" = ${grantId}::uuid AND "workspaceId" = ${workspaceId}::uuid FOR NO KEY UPDATE`;
    const grant = await tx.standingGrant.findFirst({ where: { id: grantId, workspaceId } });
    if (!grant) throw new StandingGrantError("standing_grant_not_found", "This grant no longer exists.");
    return grant;
  }

  /** Another live grant for the same rule and destination. */
  function duplicateOf(tx: Tx, grant: { id?: string; autopilotRuleId: string; kind: StandingGrantKind; socialAccountId: string | null }) {
    return tx.standingGrant.findFirst({
      where: {
        ...(grant.id ? { id: { not: grant.id } } : {}),
        autopilotRuleId: grant.autopilotRuleId,
        kind: grant.kind,
        status: { in: ["active", "paused"] },
        ...(grant.socialAccountId ? { socialAccountId: grant.socialAccountId } : {}),
      },
      select: { id: true },
    });
  }

  return {
    /** The Workspace's grants with this period's usage and recent history. Members can see them;
     * only Owners and Admins see the reviewers' addresses. */
    async list(scope: ActorScope): Promise<StandingGrantView[]> {
      await deps.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
      const canManage = await requireGrantManager(scope).then(() => true, (error) => {
        if (error instanceof ExpectedDomainFailureError) return false;
        throw error;
      });
      const at = now();
      const grants = await prisma.standingGrant.findMany({
        where: { workspaceId: scope.workspaceId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: MAX_LISTED_GRANTS,
        include: {
          autopilotRule: { select: { name: true } },
          socialAccount: { select: { displayName: true, handle: true } },
          grantedBy: { select: { firstName: true, lastName: true, primaryEmail: true } },
        },
      });
      if (grants.length === 0) return [];
      const ids = grants.map((grant) => grant.id);
      const since = (ms: number) => new Date(at.getTime() - ms);
      // One query for each thing, not one per grant.
      const countBy = async (grouped: PromiseLike<unknown>) =>
        new Map(((await grouped) as Array<{ standingGrantId: string | null; _count: { _all: number } }>).map((row) => [row.standingGrantId, row._count._all]));
      const [postDay, postWeek, roundDay, roundWeek, events, posts, rounds, optedOut] = await Promise.all([
        countBy(prisma.socialPost.groupBy({ by: ["standingGrantId"], where: { standingGrantId: { in: ids }, proposal: { acceptedAt: { gte: since(DAY_MS) } } }, _count: { _all: true } })),
        countBy(prisma.socialPost.groupBy({ by: ["standingGrantId"], where: { standingGrantId: { in: ids }, proposal: { acceptedAt: { gte: since(WEEK_MS) } } }, _count: { _all: true } })),
        countBy(prisma.reviewRound.groupBy({ by: ["standingGrantId"], where: { standingGrantId: { in: ids }, createdAt: { gte: since(DAY_MS) } }, _count: { _all: true } })),
        countBy(prisma.reviewRound.groupBy({ by: ["standingGrantId"], where: { standingGrantId: { in: ids }, createdAt: { gte: since(WEEK_MS) } }, _count: { _all: true } })),
        prisma.standingGrantEvent.findMany({ where: { grantId: { in: ids } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
        prisma.$queryRaw<Array<{ id: string; grantId: string; projectId: string; platform: string; status: string; at: Date }>>`
          SELECT "id", "standingGrantId" AS "grantId", "projectId", "platform"::text AS "platform", "status"::text AS "status", "at" FROM (
            SELECT p."id", p."standingGrantId", p."projectId", p."platform", p."status", COALESCE(p."scheduledFor", p."createdAt") AS "at",
              ROW_NUMBER() OVER (PARTITION BY p."standingGrantId" ORDER BY p."updatedAt" DESC, p."id") AS "n"
            FROM "SocialPost" p WHERE p."standingGrantId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          ) ranked WHERE "n" <= ${HISTORY_SENT}`,
        prisma.$queryRaw<Array<{ id: string; grantId: string; projectId: string; title: string; status: string; at: Date }>>`
          SELECT "id", "standingGrantId" AS "grantId", "projectId", "title", "status", "at" FROM (
            SELECT r."id", r."standingGrantId", r."projectId", r."title", r."status", r."createdAt" AS "at",
              ROW_NUMBER() OVER (PARTITION BY r."standingGrantId" ORDER BY r."createdAt" DESC, r."id") AS "n"
            FROM "ReviewRound" r WHERE r."standingGrantId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          ) ranked WHERE "n" <= ${HISTORY_SENT}`,
        canManage
          ? optedOutReviewers(prisma, scope.workspaceId, grants.flatMap((grant) => emailsOf(grant.reviewerEmails)))
          : Promise.resolve(new Set<string>()),
      ]);
      const actors = await prisma.user.findMany({
        where: { id: { in: [...new Set(events.flatMap((event) => (event.actorUserId ? [event.actorUserId] : [])))] } },
        select: { id: true, firstName: true, lastName: true, primaryEmail: true },
      });
      const actorName = new Map(actors.map((user) => [user.id, personName(user) ?? "A teammate"]));
      return grants.map((grant) => {
        const account = grant.socialAccount;
        const reviewers = emailsOf(grant.reviewerEmails);
        const posted = grant.kind === "publish";
        return {
          id: grant.id,
          kind: grant.kind,
          status: grant.status,
          revision: grant.revision,
          autopilotRuleId: grant.autopilotRuleId,
          ruleName: grant.autopilotRule?.name ?? "Deleted rule",
          socialAccountId: grant.socialAccountId,
          accountLabel: account ? `${account.displayName}${account.handle ? ` (${account.handle})` : ""}` : null,
          reviewerEmails: canManage ? reviewers : [],
          reviewerCount: reviewers.length,
          optedOut: reviewers.filter((email) => optedOut.has(email)),
          dailyCap: grant.dailyCap,
          weeklyCap: grant.weeklyCap,
          usedDay: (posted ? postDay : roundDay).get(grant.id) ?? 0,
          usedWeek: (posted ? postWeek : roundWeek).get(grant.id) ?? 0,
          expiresAt: grant.expiresAt.toISOString(),
          pausedReason: grant.pausedReason,
          pausedMessage: grant.status === "paused" ? standingGrantPauseMessage(grant.pausedReason) : null,
          grantedByName: grant.grantedBy ? personName(grant.grantedBy) : null,
          createdAt: grant.createdAt.toISOString(),
          history: events.filter((event) => event.grantId === grant.id).slice(0, HISTORY_EVENTS).map((event) => ({
            kind: event.kind,
            revision: event.revision,
            reason: event.reason,
            actorName: event.actorUserId ? (actorName.get(event.actorUserId) ?? "A teammate") : null,
            at: event.createdAt.toISOString(),
          })),
          sent: [
            ...posts.filter((post) => post.grantId === grant.id).map((post) => ({
              kind: "post" as const, id: post.id, projectId: post.projectId, at: post.at.toISOString(),
              label: `${post.platform.replaceAll("_", " ")} post, ${post.status.replaceAll("_", " ")}`,
            })),
            ...rounds.filter((round) => round.grantId === grant.id).map((round) => ({
              kind: "round" as const, id: round.id, projectId: round.projectId, at: round.at.toISOString(),
              label: `${round.title}, ${round.status}`,
            })),
          ],
        } satisfies StandingGrantView;
      });
    },

    async create(scope: ActorScope, input: CreateStandingGrantInput): Promise<{ id: string }> {
      const actor = await requireGrantManager(scope);
      const parsed = createStandingGrantSchema.parse(input);
      requireGrantPlan(actor.pricingTier, parsed.kind);
      const at = now();
      return prisma.$transaction(async (tx) => {
        // The rule's row serializes grants for one rule, so two requests can't both pass the duplicate check.
        if (!(await lockRule(tx, scope.workspaceId, parsed.autopilotRuleId))) {
          throw new StandingGrantError("standing_grant_rule_not_found", "Choose one of this Workspace's Autopilot rules.");
        }
        let socialAccountId: string | null = null;
        if (parsed.kind === "publish") {
          const account = await tx.socialAccount.findFirst({
            where: { id: parsed.socialAccountId, workspaceId: scope.workspaceId },
            select: { id: true, platform: true, status: true },
          });
          // TikTok needs the creator's own choices on every post, so a grant can never accept for it.
          if (account?.platform === "tiktok") throw new StandingGrantError("standing_grant_tiktok_excluded", "TikTok needs the creator's choices on every post, so it can't hold a standing grant.");
          if (!account || account.status !== "active") throw new StandingGrantError("standing_grant_account_unavailable", "Choose a connected account of this Workspace.");
          await requirePublishableSocialAccount(tx, { workspaceId: scope.workspaceId, accountId: account.id, tier: actor.pricingTier });
          socialAccountId = account.id;
        }
        if (await duplicateOf(tx, { autopilotRuleId: parsed.autopilotRuleId, kind: parsed.kind, socialAccountId })) {
          throw new StandingGrantError("standing_grant_duplicate", "This rule already has a grant for that destination.");
        }
        const grant = await tx.standingGrant.create({
          data: {
            workspaceId: scope.workspaceId,
            kind: parsed.kind,
            autopilotRuleId: parsed.autopilotRuleId,
            socialAccountId,
            reviewerEmails: parsed.kind === "review_send" ? normalizeReviewerEmails(parsed.reviewerEmails) : Prisma.DbNull,
            dailyCap: parsed.dailyCap,
            weeklyCap: parsed.weeklyCap,
            expiresAt: new Date(at.getTime() + parsed.expiresInDays * DAY_MS),
            grantedByUserId: scope.actorUserId,
            ruleFingerprint: (await ruleFingerprint(tx, parsed.autopilotRuleId))!,
          },
          select: { id: true },
        });
        await tx.standingGrantEvent.create({ data: { grantId: grant.id, kind: "created", revision: 1, actorUserId: scope.actorUserId } });
        return grant;
      });
    },

    /** Restates the grant's terms, binds it to the rule as it is now, bumps its revision and resumes it,
     * whether it was paused or had expired. */
    async renew(scope: ActorScope, input: RenewStandingGrantInput): Promise<void> {
      const actor = await requireGrantManager(scope);
      const parsed = renewStandingGrantSchema.parse(input);
      const at = now();
      const existing = await prisma.standingGrant.findFirst({ where: { id: parsed.grantId, workspaceId: scope.workspaceId }, select: { autopilotRuleId: true, status: true } });
      if (!existing) throw new StandingGrantError("standing_grant_not_found", "This grant no longer exists.");
      if (existing.status === "revoked" || !existing.autopilotRuleId) throw new StandingGrantError("standing_grant_closed", "This grant was revoked. Create a new one.");
      await prisma.$transaction(async (tx) => {
        // Rule, then grant: the same order as creating one and deleting a rule.
        const ruleId = existing.autopilotRuleId!;
        if (!(await lockRule(tx, scope.workspaceId, ruleId))) throw new StandingGrantError("standing_grant_closed", "This grant's rule was deleted. Create a new one.");
        const grant = await lockGrant(tx, scope.workspaceId, parsed.grantId);
        if (grant.status === "revoked") throw new StandingGrantError("standing_grant_closed", "This grant was revoked. Create a new one.");
        requireGrantPlan(actor.pricingTier, grant.kind);
        if (grant.kind === "publish" && grant.socialAccountId) {
          await requirePublishableSocialAccount(tx, { workspaceId: scope.workspaceId, accountId: grant.socialAccountId, tier: actor.pricingTier });
        }
        // Renewing a grant that had lapsed must not leave two live grants for one destination.
        if (await duplicateOf(tx, { id: grant.id, autopilotRuleId: ruleId, kind: grant.kind, socialAccountId: grant.socialAccountId })) {
          throw new StandingGrantError("standing_grant_duplicate", "This rule already has a live grant for that destination. Renew or revoke that one instead.");
        }
        const revision = grant.revision + 1;
        await tx.standingGrant.update({
          where: { id: grant.id },
          data: {
            status: "active",
            revision,
            pausedReason: null,
            pauseNoticePending: false,
            pauseNoticeLeaseUntil: null,
            dailyCap: parsed.dailyCap,
            weeklyCap: parsed.weeklyCap,
            expiresAt: new Date(at.getTime() + parsed.expiresInDays * DAY_MS),
            // Whoever renews is the person the grant now acts for, and the rule as it stands is what they approve.
            grantedByUserId: scope.actorUserId,
            ruleFingerprint: (await ruleFingerprint(tx, ruleId))!,
            ...(grant.kind === "review_send" && parsed.reviewerEmails ? { reviewerEmails: normalizeReviewerEmails(parsed.reviewerEmails) } : {}),
          },
        });
        await tx.standingGrantEvent.create({ data: { grantId: grant.id, kind: "renewed", revision, actorUserId: scope.actorUserId } });
      });
    },

    async pause(scope: ActorScope, grantId: string): Promise<void> {
      await requireGrantManager(scope);
      await prisma.$transaction(async (tx) => {
        await lockGrant(tx, scope.workspaceId, grantId);
        if (!(await pauseInTransaction(tx, { grantId, reason: "manual", actorUserId: scope.actorUserId }))) {
          throw new StandingGrantError("standing_grant_not_active", "Only an active grant can be paused.");
        }
        await flushWorkspaceEvents(tx);
      });
    },

    /** Ends the grant for good, and gives back the posts it scheduled that haven't begun to publish.
     * Revoking twice is not an error. */
    async revoke(scope: ActorScope, grantId: string): Promise<void> {
      await requireGrantManager(scope);
      await prisma.$transaction(async (tx) => {
        const grant = await lockGrant(tx, scope.workspaceId, grantId);
        if (grant.status === "revoked") return;
        await tx.standingGrant.update({ where: { id: grantId }, data: { status: "revoked", pauseNoticePending: false, pauseNoticeLeaseUntil: null } });
        await tx.standingGrantEvent.create({ data: { grantId, kind: "revoked", revision: grant.revision, actorUserId: scope.actorUserId } });
      });
      await returnGrantPosts(prisma);
    },

    /** Pauses a grant on the system's own account, such as when its granter loses the role. */
    async pauseBySystem(grantId: string, reason: StandingGrantPauseReason, revision?: number): Promise<boolean> {
      return prisma.$transaction(async (tx) => {
        const paused = await pauseInTransaction(tx, { grantId, reason, actorUserId: null, revision });
        await flushWorkspaceEvents(tx);
        return paused;
      });
    },

    /** The maintenance sweep: grants past their expiry become `expired`, each with
     * its audit line and its one `grant.expired` event, and the posts of grants that
     * ended go back to the proposal inbox. Returns how many grants it expired. */
    async expireDue(limit = 50): Promise<number> {
      // A downgrade pauses the grants the plan no longer covers, even ones nothing has used since.
      await pauseBeyondPlan(limit);
      const at = now();
      const due = await prisma.standingGrant.findMany({
        where: { status: { in: ["active", "paused"] }, expiresAt: { lte: at } },
        orderBy: { expiresAt: "asc" },
        take: limit,
        select: { id: true },
      });
      let expired = 0;
      for (const { id } of due) {
        expired += await prisma.$transaction(async (tx) => {
          const done = await tx.standingGrant.updateMany({
            where: { id, status: { in: ["active", "paused"] }, expiresAt: { lte: at } },
            data: { status: "expired" },
          });
          if (done.count !== 1) return 0;
          const grant = await tx.standingGrant.findUniqueOrThrow({ where: { id }, select: { workspaceId: true, kind: true, autopilotRuleId: true, revision: true } });
          await tx.standingGrantEvent.create({ data: { grantId: id, kind: "expired", revision: grant.revision, actorUserId: null } });
          queueWorkspaceEvent(tx, {
            workspaceId: grant.workspaceId,
            projectId: null,
            type: "grant.expired",
            subject: { grantId: id, kind: grant.kind, autopilotRuleId: grant.autopilotRuleId },
            dedupeKey: `grant.expired:${id}:${grant.revision}`,
          });
          await flushWorkspaceEvents(tx);
          return 1;
        });
      }
      // Also settles what an earlier sweep or revocation was interrupted before returning.
      await returnGrantPosts(prisma);
      return expired;
    },

    /** Emails the granter about each grant the system paused. When the granter is no longer an
     * Owner or Admin, the Workspace owner hears instead. A notice stays pending until the send
     * succeeds: a worker holds it for a while, and one that is skipped (emails off, no app URL)
     * or fails is tried again later. A grant that is no longer paused has nothing to announce. */
    async notifyPaused(batchSize = 10): Promise<number> {
      const send = deps.notifyPaused;
      if (!send || now().getTime() < noticesPausedUntil) return 0;
      const at = now();
      const free = { OR: [{ pauseNoticeLeaseUntil: null }, { pauseNoticeLeaseUntil: { lte: at } }] };
      const due = await prisma.standingGrant.findMany({ where: { pauseNoticePending: true, ...free }, take: batchSize, select: { id: true } });
      let notified = 0;
      for (const { id } of due) {
        const held = await prisma.standingGrant.updateMany({
          where: { id, pauseNoticePending: true, ...free },
          data: { pauseNoticeLeaseUntil: new Date(at.getTime() + NOTICE_LEASE_MS) },
        });
        if (held.count !== 1) continue;
        const settle = () => prisma.standingGrant.updateMany({ where: { id, pauseNoticePending: true }, data: { pauseNoticePending: false, pauseNoticeLeaseUntil: null } });
        const row = await prisma.standingGrant.findUnique({
          where: { id },
          select: {
            workspaceId: true,
            status: true,
            revision: true,
            pausedReason: true,
            grantedByUserId: true,
            autopilotRule: { select: { name: true } },
            socialAccount: { select: { displayName: true } },
            reviewerEmails: true,
            grantedBy: { select: { primaryEmail: true, emailVerifiedAt: true } },
            workspace: { select: { owner: { select: { primaryEmail: true, emailVerifiedAt: true } } } },
          },
        });
        // Renewed, revoked or expired since: a "paused" email would only mislead.
        if (!row || row.status !== "paused" || !row.pausedReason) {
          await settle();
          continue;
        }
        const granterRole = row.grantedByUserId
          ? (await prisma.workspaceMember.findFirst({ where: { workspaceId: row.workspaceId, userId: row.grantedByUserId }, select: { role: true } }))?.role
          : null;
        const granterManages = granterRole === "owner" || granterRole === "admin";
        const recipient = [granterManages ? row.grantedBy : null, row.workspace.owner].find((user) => user?.primaryEmail && user.emailVerifiedAt);
        if (!recipient?.primaryEmail) {
          log({ level: "warn", message: "standing_grant_notice_skipped", grantId: id, reason: "no_verified_recipient" });
          await settle();
          continue;
        }
        const count = emailsOf(row.reviewerEmails).length;
        try {
          const result = await send({
            to: recipient.primaryEmail,
            grantId: id,
            ruleName: row.autopilotRule?.name ?? "A deleted rule",
            destination: row.socialAccount ? row.socialAccount.displayName : `${count} reviewer${count === 1 ? "" : "s"}`,
            reason: standingGrantPauseMessage(row.pausedReason) ?? "The grant paused.",
            idempotencyKey: `standing-grant-paused:${id}:${row.revision}`,
          });
          if (result.sent) {
            await settle();
            notified += 1;
            continue;
          }
          await prisma.standingGrant.updateMany({ where: { id, pauseNoticePending: true }, data: { pauseNoticeLeaseUntil: new Date(now().getTime() + NOTICE_RETRY_MS) } });
          noticesPausedUntil = now().getTime() + NOTICE_RETRY_MS;
          log({ level: "warn", message: "standing_grant_notice_skipped", grantId: id, reason: result.reason, retryAfterMs: NOTICE_RETRY_MS });
          break;
        } catch (error) {
          // Left pending under its lease: the next pass after the lease tries again.
          log({ level: "error", message: "standing_grant_notice_failed", grantId: id, errorName: error instanceof Error ? error.name : "unknown" });
        }
      }
      return notified;
    },
  };
}

export type StandingGrants = ReturnType<typeof createStandingGrants>;
