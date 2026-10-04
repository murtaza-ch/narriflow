import type { projectService, socialService, clipService } from "@narriflow/services";
import type { AutopilotRuleSnapshot, ClipExportSnapshot, SocialAccountSnapshot, SocialPostSnapshot } from "@narriflow/validators";

type Project = NonNullable<Awaited<ReturnType<typeof projectService.getProjectSnapshot>>["project"]>;
export function mcpProject(project: Project, appOrigin: string) {
  return { projectId: project.id, workspaceId: project.workspaceId, title: project.title,
    sourceType: project.sourceType, ingestStatus: project.ingestStatus,
    durationSeconds: project.sourceDurationSeconds, languageCode: project.languageCode,
    createdAt: project.createdAt, reviewUrl: `${appOrigin}/projects/${project.id}` };
}
export function mcpClip(clip: Awaited<ReturnType<typeof clipService.getClipReviewFacts>>, appOrigin: string, includeTranscriptExcerpt = false) {
  return { clipId: clip.id, projectId: clip.projectId, editorRevision: clip.editorRevision,
    title: clip.title, status: clip.status, startSec: clip.startSec, endSec: clip.endSec,
    durationSec: clip.durationSec, hookText: clip.hookText.slice(0, 2_000), reasoning: clip.reasoning.slice(0, 2_000),
    category: clip.category, platformFit: clip.platformFit,
    scores: { virality: clip.viralityScore, hookStrength: clip.hookStrengthScore,
      emotionalIntensity: clip.emotionalIntensityScore, storyCompleteness: clip.storyCompletenessScore,
      pacing: clip.pacingScore, durationOptimality: clip.durationOptimalityScore }, hasPreview: clip.hasPreview,
    ...(includeTranscriptExcerpt ? { transcriptExcerpt: clip.transcriptExcerpt ?? "" } : {}),
    reviewUrl: `${appOrigin}/projects/${clip.projectId}/clips/${clip.id}/studio` };
}
export function mcpExport(snapshot: ClipExportSnapshot, appOrigin: string) {
  return { exportId: snapshot.id, projectId: snapshot.projectId, clipId: snapshot.clipId,
    editorRevision: snapshot.editorRevision, currentEditorRevision: snapshot.currentEditorRevision,
    isOlderVersion: snapshot.isOlderVersion, resolution: snapshot.resolution, status: snapshot.status,
    progress: snapshot.progress, createdAt: snapshot.createdAt, completedAt: snapshot.completedAt,
    variants: snapshot.variants.map((variant) => ({ variantId: variant.id, aspectRatio: variant.aspectRatio,
      resolution: variant.resolution, status: variant.status, hasAsset: variant.hasAsset, durationSeconds: variant.durationSec })),
    reviewUrl: `${appOrigin}/projects/${snapshot.projectId}/clips/${snapshot.clipId}/exports/${snapshot.id}`,
    statusTool: "narriflow_get_clip_export" as const };
}
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
