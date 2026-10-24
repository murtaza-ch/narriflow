import type { Bundle, ZObject } from 'zapier-platform-core';
import { apiOrNull } from './api';
import type { ClipResult, ClipsResult, OperationView, ProjectResult } from './types';

/**
 * Triggers return cheap items straight from the feed, with a `details` field
 * that `z.dehydrate` points at one of these. Zapier runs a hydrator only for an
 * event it has not delivered yet, so a poll that finds nothing new reads nothing
 * but the feed. Each returns `available: false` for a subject that is gone.
 */

const TOP_CLIPS = 10;
const gone = { available: false };

function input<T>(bundle: Bundle) {
  return bundle.inputData as unknown as T;
}

export async function hydrateClipsReady(z: ZObject, bundle: Bundle) {
  const { projectId } = input<{ projectId: string }>(bundle);
  const [project, clips] = await Promise.all([
    apiOrNull<ProjectResult>(z, bundle, { path: `/projects/${projectId}` }),
    apiOrNull<ClipsResult>(z, bundle, { path: `/projects/${projectId}/clips`, query: { limit: TOP_CLIPS } }),
  ]);
  if (!project || !clips) return gone;
  const top = clips.items;
  return {
    available: true,
    projectTitle: project.project.title,
    reviewUrl: project.project.reviewUrl,
    clipCount: top.length,
    topClipId: top[0]?.clipId ?? null,
    topClipTitle: top[0]?.title ?? null,
    clipTitles: top.map((clip, index) => `${index + 1}. ${clip.title ?? 'Untitled clip'}`).join('\n'),
    clips: top.map((clip) => ({
      clipId: clip.clipId,
      title: clip.title,
      hookText: clip.hookText,
      viralityScore: clip.scores.virality,
      durationSec: clip.durationSec,
      reviewUrl: clip.reviewUrl,
    })),
  };
}

export async function hydrateExportFinished(z: ZObject, bundle: Bundle) {
  const { operationId } = input<{ operationId: string }>(bundle);
  const operation = await apiOrNull<OperationView>(z, bundle, { path: `/operations/${encodeURIComponent(operationId)}` });
  if (!operation?.results.exportId) return gone;
  const variants = operation.items.filter((item) => item.kind === 'variant');
  return {
    available: true,
    exportId: operation.results.exportId,
    projectId: operation.results.projectId,
    clipId: operation.results.clipIds[0] ?? null,
    formatCount: variants.length,
    readyFormatCount: variants.filter((item) => item.state === 'completed').length,
    reviewUrl: operation.reviewUrl,
  };
}

export async function hydrateProject(z: ZObject, bundle: Bundle) {
  const { projectId } = input<{ projectId: string }>(bundle);
  const project = await apiOrNull<ProjectResult>(z, bundle, { path: `/projects/${projectId}` });
  if (!project) return gone;
  return {
    available: true,
    projectTitle: project.project.title,
    sourceType: project.project.sourceType,
    durationSeconds: project.project.durationSeconds,
    reviewUrl: project.project.reviewUrl,
  };
}

/** The post is the news, so a post whose clip is gone still delivers its event, without the clip's fields. */
export async function hydratePostClip(z: ZObject, bundle: Bundle) {
  const { clipId } = input<{ clipId: string | null }>(bundle);
  const clip = clipId ? await apiOrNull<ClipResult>(z, bundle, { path: `/clips/${clipId}` }) : null;
  if (!clip) return gone;
  return { available: true, clipTitle: clip.clip.title, clipReviewUrl: clip.clip.reviewUrl };
}
