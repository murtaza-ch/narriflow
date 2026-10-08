import type { socialService } from "@narriflow/services";
import type { AutopilotRuleSnapshot, SocialAccountSnapshot, SocialPostSnapshot } from "@narriflow/validators";

export function mcpAutopilotRule(rule: AutopilotRuleSnapshot) {
  return { ruleId: rule.id, workspaceId: rule.workspaceId, name: rule.name, rssUrl: rule.rssUrl,
    status: rule.status, intervalMinutes: rule.intervalMinutes, maxEpisodesPerRun: rule.maxEpisodesPerRun,
    nextRunAt: rule.nextRunAt, lastCheckedAt: rule.lastCheckedAt, lastSuccessAt: rule.lastSuccessAt,
    importedEpisodeCount: rule.importedEpisodeCount };
}
export function mcpSocialAccount(account: SocialAccountSnapshot) {
  return { accountId: account.id, platform: account.platform, displayName: account.displayName,
    handle: account.handle, status: account.status };
}
export function mcpPublication(post: SocialPostSnapshot, appOrigin: string) {
  return { socialPostId: post.id, projectId: post.projectId, clipId: post.clipId, accountId: post.accountId,
    platform: post.platform, deliveryMode: post.deliveryMode, status: post.status, caption: post.caption,
    scheduledFor: post.scheduledFor, postedAt: post.postedAt, externalUrl: post.externalUrl,
    errorCode: post.errorCode, allowedActions: post.allowedActions,
    reviewUrl: `${appOrigin}/projects/${post.projectId}?tab=publishing` };
}
export function mcpPublicationRecovery(post: Awaited<ReturnType<typeof socialService.inspectPublication>>, appOrigin: string) {
  return { socialPostId: post.id, projectId: post.projectId, platform: post.platform, status: post.status,
    scheduledFor: post.scheduledFor?.toISOString() ?? null, postedAt: post.postedAt?.toISOString() ?? null,
    externalUrl: post.externalUrl, errorCode: post.errorCode, allowedActions: post.allowedActions,
    attempts: post.publicationAttempts.slice(0, 20).map((attempt) => ({ attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber, phase: attempt.phase, outcome: attempt.outcome,
      failureCode: attempt.failureCode, startedAt: attempt.startedAt?.toISOString() ?? null,
      terminalAt: attempt.terminalAt?.toISOString() ?? null,
      decisions: attempt.manualDecisions.slice(0, 20).map((decision) => ({ kind: decision.kind,
        reason: decision.reason, evidenceKind: decision.evidenceKind, ownershipValidated: decision.ownershipValidated,
        createdAt: decision.createdAt.toISOString() })) })), reviewUrl: `${appOrigin}/projects/${post.projectId}?tab=publishing` };
}
