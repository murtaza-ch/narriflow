import { z } from "zod";

/** Standing Grants: authority an Owner or Admin gives one Autopilot rule's
 * output to go out without a click. `publish` accepts the rule's proposed posts
 * into one Social Account's queue; `review_send` sends its finished exports to
 * named reviewers as a Review Round. A grant has caps, an expiry and a pause,
 * and it never weakens a Brand Profile's approval rule. */

const id = z.string().uuid();

export const STANDING_GRANT_KINDS = ["publish", "review_send"] as const;
export const standingGrantKindSchema = z.enum(STANDING_GRANT_KINDS);
export type StandingGrantKind = z.infer<typeof standingGrantKindSchema>;

export const STANDING_GRANT_STATUSES = ["active", "paused", "expired", "revoked"] as const;
export const standingGrantStatusSchema = z.enum(STANDING_GRANT_STATUSES);
export type StandingGrantStatus = z.infer<typeof standingGrantStatusSchema>;

/** A grant lasts at most this long; after that a person renews it. */
export const STANDING_GRANT_MAX_DAYS = 90;
export const STANDING_GRANT_MAX_DAILY_CAP = 20;
export const STANDING_GRANT_MAX_WEEKLY_CAP = 100;
export const STANDING_GRANT_MAX_REVIEWERS = 25;

/** Why a grant is paused. A person's pause is `manual`; the rest are the system's. */
export const STANDING_GRANT_PAUSE_REASONS = ["manual", "post_failed", "post_needs_attention", "granter_unavailable", "rule_changed", "plan_lost"] as const;
export const standingGrantPauseReasonSchema = z.enum(STANDING_GRANT_PAUSE_REASONS);
export type StandingGrantPauseReason = z.infer<typeof standingGrantPauseReasonSchema>;

const PAUSE_MESSAGES: Record<StandingGrantPauseReason, string> = {
  manual: "Paused by a person.",
  post_failed: "A post accepted under this grant failed, so it paused.",
  post_needs_attention: "A post accepted under this grant needs attention, so it paused.",
  granter_unavailable: "The person who granted this is no longer an Owner or Admin, so it paused.",
  rule_changed: "The Autopilot rule or its Brand Profile's approval rule changed after this was granted, so it paused. Renew it to approve the new settings.",
  plan_lost: "The Workspace's plan no longer covers this grant, so it paused. It stays paused after a plan change; renew it to turn it back on.",
};

export function standingGrantPauseMessage(reason: string | null): string | null {
  if (!reason) return null;
  return reason in PAUSE_MESSAGES ? PAUSE_MESSAGES[reason as StandingGrantPauseReason] : "Paused.";
}

const caps = {
  dailyCap: z.number().int().min(1).max(STANDING_GRANT_MAX_DAILY_CAP).describe("Most deliveries in any 24 hours"),
  weeklyCap: z.number().int().min(1).max(STANDING_GRANT_MAX_WEEKLY_CAP).describe("Most deliveries in any 7 days"),
  expiresInDays: z.number().int().min(1).max(STANDING_GRANT_MAX_DAYS).describe("The grant ends this many days from now"),
};

const reviewerEmails = z.array(z.string().trim().email().max(254)).min(1).max(STANDING_GRANT_MAX_REVIEWERS)
  .describe("The reviewers each round is sent to");

const weeklyAtLeastDaily = (value: { dailyCap: number; weeklyCap: number }, context: z.RefinementCtx) => {
  if (value.weeklyCap < value.dailyCap) {
    context.addIssue({ code: "custom", path: ["weeklyCap"], message: "The weekly cap can't be lower than the daily cap" });
  }
};

export const createStandingGrantSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("publish"), autopilotRuleId: id, socialAccountId: id, ...caps }),
  z.strictObject({ kind: z.literal("review_send"), autopilotRuleId: id, reviewerEmails, ...caps }),
]).superRefine(weeklyAtLeastDaily);
export type CreateStandingGrantInput = z.infer<typeof createStandingGrantSchema>;

/** Renewing restates the grant's terms and starts a new revision. It also resumes a paused or expired grant. */
export const renewStandingGrantSchema = z.strictObject({
  grantId: id,
  reviewerEmails: reviewerEmails.optional(),
  ...caps,
}).superRefine(weeklyAtLeastDaily);
export type RenewStandingGrantInput = z.infer<typeof renewStandingGrantSchema>;

export const standingGrantReferenceSchema = z.strictObject({ grantId: id });

/** One line of a grant's audit trail. */
export interface StandingGrantEventView {
  kind: string;
  revision: number;
  reason: string | null;
  actorName: string | null;
  at: string;
}

export interface StandingGrantView {
  id: string;
  kind: StandingGrantKind;
  status: StandingGrantStatus;
  revision: number;
  /** Null once the rule was deleted; the grant was revoked then and stays as the audit trail. */
  autopilotRuleId: string | null;
  ruleName: string;
  socialAccountId: string | null;
  accountLabel: string | null;
  /** Only Owners and Admins see the addresses; everyone sees how many. */
  reviewerEmails: string[];
  reviewerCount: number;
  /** Reviewers who asked to stop automated review requests from this Workspace. Owners and Admins only. */
  optedOut: string[];
  dailyCap: number;
  weeklyCap: number;
  usedDay: number;
  usedWeek: number;
  expiresAt: string;
  pausedReason: string | null;
  pausedMessage: string | null;
  grantedByName: string | null;
  createdAt: string;
  /** Newest first, a bounded window. */
  history: StandingGrantEventView[];
  sent: Array<{ kind: "post" | "round"; id: string; projectId: string; at: string; label: string }>;
}
