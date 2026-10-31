import type { ExecutionArtifact, MediaCleanupObligation, Prisma } from "@prisma/client";
import { publicationObjectIsHeld } from "./publication-cleanup";
import { generatedMediaObjectIsHeld } from "./generated-media-execution";
import { executionInputRetainUntil } from "./execution-input-retention";
import { isSelectionExecutionObjectKey, selectionExecutionObjectRetainUntil } from "./execution-object-cleanup";
import { MediaCleanupControlError, type MediaCleanupHold } from "./media-cleanup-control";
import { tryDerivePeaksStorageKey } from "./clip-preview-storage";

type Tx = Prisma.TransactionClient;
const revisit = (now: Date) => new Date(now.getTime() + 86_400_000);
async function projectHeld(tx: Tx, id: string, now: Date) {
  const project = await tx.project.findUnique({ where: { id }, select: { purgeStartedAt: true, expiresAt: true } });
  return Boolean(project && !project.purgeStartedAt && (!project.expiresAt || project.expiresAt > now));
}
async function assignedReferenceHeld(tx: Tx, artifact: ExecutionArtifact, now: Date): Promise<boolean> {
  const attempt = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken: artifact.attemptToken }, select: { dispatch: { select: { subjectKind: true, subjectId: true } } } });
  const { subjectKind: kind, subjectId: id } = attempt.dispatch;
  switch (kind) {
    case "ingest_job": {
      if (artifact.role === "source_audio" && await tx.sourceAudio.findUnique({ where: { storageKey: artifact.storageKey }, select: { id: true } })) return true;
      const job = await tx.ingestJob.findUnique({ where: { id }, select: { projectId: true } });
      return Boolean(job && await projectHeld(tx, job.projectId, now));
    }
    case "clip_preparation": {
      const job = await tx.clipPreparation.findUnique({ where: { id }, select: { projectId: true } });
      return Boolean(job && await projectHeld(tx, job.projectId, now));
    }
    case "render_group": {
      const job = await tx.renderGroup.findUnique({ where: { id }, select: { workflowRun: { select: { projectId: true } } } });
      return Boolean(job && await projectHeld(tx, job.workflowRun.projectId, now));
    }
    case "workflow_run": {
      const job = await tx.workflowRun.findUnique({ where: { id }, select: { projectId: true, stage: true, status: true } });
      if (job?.stage === "export_bundle" && artifact.role === "export_bundle") {
        const bundle = await tx.exportBundle.findUnique({ where: { workflowRunId: id }, select: { status: true, storageKey: true, expiresAt: true } });
        if (!bundle) return false;
        if (["queued", "building"].includes(bundle.status) && ["queued", "running", "waiting"].includes(job.status)) return true;
        return bundle.status === "completed" && bundle.storageKey === artifact.storageKey && (!bundle.expiresAt || bundle.expiresAt > now);
      }
      return Boolean(job && await projectHeld(tx, job.projectId, now));
    }
    case "generated_media": {
      const job = await tx.generatedMediaJob.findUnique({ where: { id }, select: { projectId: true } });
      return Boolean(job && await projectHeld(tx, job.projectId, now));
    }
    case "thumbnail_frame": {
      const job = await tx.thumbnailFrameOperation.findUnique({ where: { id }, select: { projectId: true } });
      return Boolean(job && await projectHeld(tx, job.projectId, now));
    }
    case "native_validation": return Boolean(await tx.nativeValidationJob.findUnique({ where: { id }, select: { id: true } }));
    case "outbound_probe": return Boolean(await tx.outboundProbe.findFirst({ where: { id, resultStorageKey: artifact.storageKey }, select: { id: true } }));
    case "outbound_delivery": return Boolean(await tx.outboundDelivery.findFirst({ where: { id, lastReceiptArtifactId: artifact.id, expiresAt: { gt: now } }, select: { id: true } }));
    case "social_publication": return publicationObjectIsHeld(tx, artifact.storageKey, now);
    case "clip_selection_window": return Boolean(await tx.clipSelectionWindow.findFirst({ where: { id, resultStorageKey: artifact.storageKey }, select: { id: true } }));
    case "dubbing": {
      const row = await tx.clipDub.findUnique({ where: { id }, select: { audioStorageKey: true, renderStorageKey: true } });
      return Boolean(row && [row.audioStorageKey, row.renderStorageKey].includes(artifact.storageKey));
    }
    case "export_bundle": return Boolean(await tx.exportBundle.findFirst({ where: { id, OR: [{ storageKey: artifact.storageKey }, { attemptStorageKey: artifact.storageKey }] }, select: { id: true } }));
    default: throw new MediaCleanupControlError("cleanup_intent_invalid");
  }
}
async function retiredReferenceHeld(tx: Tx, intent: Readonly<MediaCleanupObligation>) {
  const key = intent.objectKey;
  if (intent.cleanupClass === "generated_asset" || intent.cleanupClass === "thumbnail_asset") {
    if (await tx.visualAsset.findUnique({ where: { storageKey: key }, select: { deletedAt: true } }).then(row => row?.deletedAt === null)) return true;
    if (intent.cleanupClass === "generated_asset" && await generatedMediaObjectIsHeld(tx, key)) return true;
  }
  if (intent.projectId) {
    const project = await tx.project.findUnique({ where: { id: intent.projectId }, select: { sourceStorageKey: true } });
    if (project?.sourceStorageKey === key) return true;
  }
  if (intent.clipId) {
    const clip = await tx.clip.findUnique({ where: { id: intent.clipId }, select: { previewStorageKey: true } });
    if (clip?.previewStorageKey === key || (clip?.previewStorageKey && tryDerivePeaksStorageKey(clip.previewStorageKey) === key)) return true;
    if (await tx.clipRender.findFirst({ where: { clipId: intent.clipId, storageKey: key }, select: { id: true } })) return true;
    if (await tx.clipDub.findFirst({ where: { clipId: intent.clipId, OR: [{ audioStorageKey: key }, { renderStorageKey: key }] }, select: { id: true } })) return true;
  }
  return false;
}
/** Only known exact references are read. Outstanding grants and bounded native
 * HTTP drain first; the storage adapter then aborts exact-key MPUs before delete.
 * Project-backed committed evidence is retained through its Project lifetime.
 * Private validation/probe evidence remains held until its owning row is purged. */
export const mediaCleanupObjectRetainUntil: MediaCleanupHold = async (tx, intent, now) => {
  const artifact = await tx.executionArtifact.findUnique({ where: { storageKey: intent.objectKey }, include: { attempt: { select: { operationDeadlineAt: true } } } });
  if (artifact) {
    const until = new Date(Math.max(artifact.grantExpiresAt.getTime(), artifact.attempt.operationDeadlineAt.getTime()) + 120_000);
    if (until > now) return until;
    if (await tx.visualAsset.findUnique({ where: { storageKey: intent.objectKey }, select: { deletedAt: true } }).then(row => row?.deletedAt === null) ||
      await tx.brandFont.findUnique({ where: { storageKey: intent.objectKey }, select: { id: true } })) return revisit(now);
    if (artifact.committedAt && await assignedReferenceHeld(tx, artifact, now)) return revisit(now);
  } else if (intent.cleanupClass === "assigned_artifact") {
    // Missing ownership evidence is not an orphan proof.
    throw new MediaCleanupControlError("cleanup_intent_invalid");
  }
  if (intent.cleanupClass === "notification_body") {
    const delivery = await tx.outboundDelivery.findFirst({ where: { bodyStorageKey: intent.objectKey }, select: { expiresAt: true } });
    return delivery && delivery.expiresAt > now ? new Date(delivery.expiresAt.getTime() + 120_000) : null;
  }
  if (intent.cleanupClass === "execution_input") return isSelectionExecutionObjectKey(intent.objectKey) ? selectionExecutionObjectRetainUntil(tx, intent.objectKey) : executionInputRetainUntil(tx, intent.objectKey);
  if (intent.cleanupClass === "publication_private" && await publicationObjectIsHeld(tx, intent.objectKey, now)) return revisit(now);
  if (await retiredReferenceHeld(tx, intent)) return revisit(now);
  return null;
};
