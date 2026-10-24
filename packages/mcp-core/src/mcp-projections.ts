import type { socialService } from "@narriflow/services";
import type { AutopilotRuleSnapshot, SocialPostSnapshot } from "@narriflow/validators";

export function mcpAutopilotRule(rule: AutopilotRuleSnapshot) {
  return { ruleId: rule.id, workspaceId: rule.workspaceId, name: rule.name, rssUrl: rule.rssUrl,
    status: rule.status, recipeId: rule.recipeId, recipeName: rule.recipeName,
    // A paused rule's lastError says who lost access or which Brand Profile its Recipe uses failed.
    pausedReason: rule.status === "paused" ? rule.lastError : null,
    intervalMinutes: rule.intervalMinutes, maxEpisodesPerRun: rule.maxEpisodesPerRun,
    nextRunAt: rule.nextRunAt, lastCheckedAt: rule.lastCheckedAt, lastSuccessAt: rule.lastSuccessAt,
    importedEpisodeCount: rule.importedEpisodeCount };
}
export function mcpPublication(post: SocialPostSnapshot, appOrigin: string) {
  return { socialPostId: post.id, projectId: post.projectId, clipId: post.clipId, accountId: post.accountId,
    platform: post.platform, deliveryMode: post.deliveryMode, status: post.status, caption: post.caption,
    scheduledFor: post.scheduledFor, postedAt: post.postedAt, externalUrl: post.externalUrl,
    errorCode: post.errorCode, latestMetrics: post.latestMetrics, allowedActions: post.allowedActions,
    reviewUrl: `${appOrigin}/projects/${post.projectId}?tab=publishing` };
}
export function mcpPublicationRecovery(post: Awaited<ReturnType<typeof socialService.inspectPublication>>, appOrigin: string) {
  return { socialPostId: post.id, projectId: post.projectId, platform: post.platform, status: post.status,
    scheduledFor: post.scheduledFor?.toISOString() ?? null, postedAt: post.postedAt?.toISOString() ?? null,
    externalUrl: post.externalUrl, errorCode: post.errorCode, latestMetrics: post.latestMetrics, allowedActions: post.allowedActions,
    attempts: post.publicationAttempts.slice(0, 20).map((attempt) => ({ attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber, phase: attempt.phase, outcome: attempt.outcome,
      failureCode: attempt.failureCode, startedAt: attempt.startedAt?.toISOString() ?? null,
      terminalAt: attempt.terminalAt?.toISOString() ?? null,
      decisions: attempt.manualDecisions.slice(0, 20).map((decision) => ({ kind: decision.kind,
        reason: decision.reason, evidenceKind: decision.evidenceKind, ownershipValidated: decision.ownershipValidated,
        createdAt: decision.createdAt.toISOString() })) })), reviewUrl: `${appOrigin}/projects/${post.projectId}?tab=publishing` };
}
