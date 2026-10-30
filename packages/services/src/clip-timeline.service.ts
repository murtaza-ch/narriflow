import { getPrismaClient } from "@narriflow/db/client";
import type { TimelineFormat } from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import { clipTimelineFiles, clipTimelineSource } from "./clip-timeline";
import { ClipTimelineError } from "./timeline-export";
import { accessibleProjectWhere } from "./project-access";
import { requirePlanFeature } from "./plan-features";
import { presignDownloadUrl } from "./r2-storage";
import { storeZip } from "./store-zip";
import { workspaceService } from "./workspace.service";

const SOURCE_DOWNLOAD_TTL_SECONDS = 15 * 60;

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

/** Editor Timelines and their source grants are a Pro feature on every surface
 * (browser, REST, MCP). Already-issued grants keep working until they expire. */
async function loadClip(scope: ActorScope, projectId: string, clipId: string) {
  const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.download");
  requirePlanFeature(actor.pricingTier, "export.timelines");
  const clip = await requirePrisma().clip.findFirst({
    where: { id: clipId, projectId, project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() } },
    include: { project: { select: { title: true, sourceStorageKey: true, sourceSizeBytes: true, sourceDurationSeconds: true, sourceProbe: true, languageCode: true, transcript: { select: { languageCode: true } } } } },
  });
  if (!clip) throw new ClipTimelineError("clip_not_found", "Clip not found");
  return clip;
}

/** A short-lived private URL for the original source, named as the timeline
 * names it. Issued only on explicit request; the audit log never records the
 * URL. */
async function grantSource(scope: ActorScope, clip: Awaited<ReturnType<typeof loadClip>>, options: { credentialKind: string }) {
  const source = clipTimelineSource(clip.project);
  const expiresAt = new Date(Date.now() + SOURCE_DOWNLOAD_TTL_SECONDS * 1000).toISOString();
  const downloadUrl = await presignDownloadUrl({ key: source.storageKey, expiresIn: SOURCE_DOWNLOAD_TTL_SECONDS, fileName: source.fileName });
  console.warn(JSON.stringify({ level: "info", message: "timeline_source_granted", projectId: clip.projectId, clipId: clip.id,
    actorUserId: scope.actorUserId, workspaceId: scope.workspaceId, credentialKind: options.credentialKind, expiresAt }));
  return {
    fileName: source.fileName,
    sizeBytes: clip.project.sourceSizeBytes === null ? null : Number(clip.project.sourceSizeBytes),
    downloadUrl,
    expiresAt,
  };
}

/** Editor timelines for a clip. The timeline and its SRT are small text, so
 * they come back directly or zipped. The original source is large, so it is
 * never zipped here: it comes as a Download Grant, under the file name the
 * timeline already refers to. */
export class ClipTimelineService {
  /** The timeline and SRT as one ZIP, for the web export page. */
  async archive(scope: ActorScope, projectId: string, clipId: string, format: TimelineFormat) {
    const clip = await loadClip(scope, projectId, clipId);
    const files = clipTimelineFiles({ clip, project: clip.project, format });
    return {
      fileName: `${files.baseName}-${format}.zip`,
      editorRevision: files.editorRevision,
      bytes: storeZip([
        { name: files.timeline.fileName, content: files.timeline.content },
        { name: files.subtitles.fileName, content: files.subtitles.content },
      ], new Date()),
    };
  }

  /** The original source alone, for the web export page's separate download. */
  async issueSourceGrant(scope: ActorScope, projectId: string, clipId: string, options: { credentialKind: string }) {
    return grantSource(scope, await loadClip(scope, projectId, clipId), options);
  }

  /** The timeline and SRT text with a Download Grant for the source. */
  async export(scope: ActorScope, projectId: string, clipId: string, format: TimelineFormat, options: { credentialKind: string }) {
    const clip = await loadClip(scope, projectId, clipId);
    const files = clipTimelineFiles({ clip, project: clip.project, format });
    return {
      projectId,
      clipId,
      editorRevision: files.editorRevision,
      format,
      timeline: { fileName: files.timeline.fileName, content: files.timeline.content },
      subtitles: { format: "srt" as const, fileName: files.subtitles.fileName, content: files.subtitles.content },
      source: await grantSource(scope, clip, options),
    };
  }
}

export const clipTimelineService = new ClipTimelineService();
