"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  requireWorkspaceAppUser,
  requireWorkspaceProject,
} from "@/lib/workspace";
import {
  clipService,
  IngestNotFailedError,
  IngestRetryLimitExceededError,
  projectService,
  workspaceLibraryService,
  QuotaExceededError,
  UploadTooLongError,
} from "@narriflow/services";
// Imported via the "./project" subpath rather than the package root: these
// error classes are new and not yet re-exported from
// packages/services/src/index.ts (owned by another concurrent agent — see
// this task's report for the exact lines to add there). The subpath resolves
// to the same underlying module either way.
import {
  ProjectAccessDeniedError,
  ProjectDeletionIncompleteError,
  ProjectHasActiveWorkflowError,
  ProjectNotFoundError,
} from "@narriflow/services/project";
import { type ClipAspectRatio, userErrorMessage } from "@narriflow/validators";

/** True for plan-limit errors that should send the user to the upgrade view. */
function isPlanLimitError(error: unknown): boolean {
  return (
    error instanceof QuotaExceededError || error instanceof UploadTooLongError
  );
}

/**
 * Plan-limit failures bounce the user back to the project they were acting on,
 * never to /dashboard: the project page renders the exact limit that blocked
 * the action (over the per-upload length cap, or out of monthly minutes) plus
 * the upgrade link. Redirecting away instead dropped the user on an unrelated
 * screen with no explanation of why nothing happened.
 */
function redirectForPlanLimit(projectId: string): never {
  redirect(`/projects/${projectId}`);
}
import {
  readContentPackFromForm,
  readLanguageCodeFromForm,
} from "../upload/_lib/content-pack-form";

export async function createFolderAction(name: string) {
  try {
    const appUser = await requireWorkspaceAppUser("content.edit");
    const folder = await workspaceLibraryService.createFolder(
      appUser.actorUserId,
      appUser.workspaceId,
      name,
    );
    revalidatePath("/projects");
    return { ok: true as const, folder: { ...folder, createdAt: folder.createdAt.toISOString() } };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Folder creation failed" };
  }
}

export async function deleteFolderAction(folderId: string) {
  const appUser = await requireWorkspaceAppUser("content.edit");
  await workspaceLibraryService.deleteFolder(appUser.actorUserId, appUser.workspaceId, folderId);
  revalidatePath("/projects");
}

export async function renameFolderAction(folderId: string, name: string) {
  try {
    const appUser = await requireWorkspaceAppUser("content.edit");
    await workspaceLibraryService.renameFolder(
      appUser.actorUserId,
      appUser.workspaceId,
      folderId,
      name,
    );
    revalidatePath("/projects");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Folder rename failed" };
  }
}

export async function moveProjectToFolderAction(projectId: string, folderId: string | null) {
  const appUser = await requireWorkspaceProject(projectId, "content.edit");
  await workspaceLibraryService.moveProject(
    appUser.actorUserId,
    appUser.workspaceId,
    projectId,
    folderId,
  );
  revalidatePath("/projects");
}

export async function createProjectFormAction(formData: FormData) {
  const appUser = await requireWorkspaceAppUser("content.edit");
  const title = String(formData.get("title") ?? "");
  const sourceMediaUrl = String(formData.get("sourceMediaUrl") ?? "");

  const project = await projectService.createProject(appUser.actorUserId, {
    title,
    sourceMediaUrl,
  }, appUser.workspaceId);

  revalidatePath("/projects");
  redirect(`/projects/${project.id}`);
}

export async function queueTranscriptionFormAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? randomUUID());

  if (!projectId) {
    throw new Error("projectId is required");
  }
  const appUser = await requireWorkspaceProject(projectId, "processing.consume");

  try {
    await projectService.triggerGeneration(
      appUser.id,
      projectId,
      {
        contentPack: readContentPackFromForm(formData),
        forceRegenerate: false,
        languageCode: readLanguageCodeFromForm(formData),
      },
      idempotencyKey,
      {
        workspaceContext: {
          workspaceId: appUser.workspaceId,
          actorUserId: appUser.actorUserId,
        },
      },
    );
  } catch (error) {
    if (isPlanLimitError(error)) {
      revalidatePath(`/projects/${projectId}`);
      redirectForPlanLimit(projectId);
    }
    throw error;
  }

  revalidatePath(`/projects/${projectId}`);
}

export const queueGenerationFormAction = queueTranscriptionFormAction;

export async function regenerateClipsFormAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const idempotencyKey = String(
    formData.get("idempotencyKey") ?? randomUUID(),
  );

  if (!projectId) {
    throw new Error("projectId is required");
  }
  const appUser = await requireWorkspaceProject(projectId, "processing.consume");

  try {
    await clipService.regenerateClips(
      appUser.id,
      projectId,
      idempotencyKey,
      readContentPackFromForm(formData),
    );
  } catch (error) {
    if (isPlanLimitError(error)) {
      revalidatePath(`/projects/${projectId}`);
      redirectForPlanLimit(projectId);
    }
    throw error;
  }

  revalidatePath(`/projects/${projectId}`);
}

export async function renderClipsFormAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const idempotencyKey = String(
    formData.get("idempotencyKey") ?? randomUUID(),
  );
  const aspectRatios = formData
    .getAll("aspectRatios")
    .map((value) => String(value))
    .filter(Boolean) as ClipAspectRatio[];

  if (!projectId) {
    throw new Error("projectId is required");
  }
  const appUser = await requireWorkspaceProject(projectId, "processing.consume");

  await clipService.triggerClipRendering(
    appUser.id,
    projectId,
    idempotencyKey,
    undefined,
    aspectRatios.length > 0 ? aspectRatios : undefined,
    "1080p",
    {
      workspaceId: appUser.workspaceId,
      actorUserId: appUser.actorUserId,
    },
  );

  revalidatePath(`/projects/${projectId}`);
}

/**
 * Re-queues ingest for a project stuck in ingestStatus "failed". Unlike the
 * sibling actions above, this returns a result instead of throwing on the
 * expected failure modes (retry limit reached, already retried elsewhere) —
 * Next.js redacts thrown Server Action errors in production, so a plain
 * throw here would surface as a generic message instead of the specific,
 * user-visible copy the Retry ingest button needs to show inline.
 */
export async function retryIngestFormAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const projectId = String(formData.get("projectId") ?? "");

  if (!projectId) {
    return { ok: false, error: "projectId is required" };
  }
  const appUser = await requireWorkspaceProject(projectId, "processing.consume");

  try {
    await projectService.retryFailedIngest(appUser.id, projectId, {
      workspaceId: appUser.workspaceId,
      actorUserId: appUser.actorUserId,
    });
  } catch (error) {
    const code =
      error instanceof IngestRetryLimitExceededError
        ? "ingest_retry_limit_exceeded"
        : error instanceof IngestNotFailedError
          ? "ingest_not_failed"
          : null;

    return {
      ok: false,
      error:
        (code && userErrorMessage(code)) ??
        "Could not retry ingest. Please try again.",
    };
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/**
 * "Email me when clips are ready" toggle on the Phase 2a processing panel.
 * Returns a typed result instead of throwing — a stray click on a stale page
 * (project deleted from another tab) should read as "couldn't save that",
 * not a redacted production error.
 */
export async function setNotifyPreferenceAction(
  projectId: string,
  notifyOnComplete: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!projectId) {
    return { ok: false, error: "projectId is required" };
  }
  const appUser = await requireWorkspaceProject(projectId, "content.edit");

  try {
    await projectService.setProjectNotifyPreference(
      appUser.id,
      projectId,
      notifyOnComplete,
    );
  } catch {
    return {
      ok: false,
      error: "Could not save this preference. Please try again.",
    };
  }

  return { ok: true };
}

/**
 * Permanently deletes a project: its R2 source, transcript, every clip,
 * render, and dub, then the DB row (see ProjectService.deleteProject for the
 * storage-then-DB ordering guarantee). Returns {ok, error} instead of
 * throwing for expected failures — Next redacts thrown Server Action errors
 * in production, and the delete confirmation UI needs the specific,
 * user-visible copy.
 *
 * A project that's already gone (ProjectNotFoundError — e.g. a double
 * submit, or a concurrent delete from another tab) is treated as success:
 * the end state the user wanted, no such project, already holds.
 */
export async function deleteProjectFormAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const projectId = String(formData.get("projectId") ?? "");

  if (!projectId) {
    return { ok: false, error: "projectId is required" };
  }
  const appUser = await requireWorkspaceProject(projectId, "content.edit");

  try {
    await projectService.deleteProject(appUser.id, projectId);
  } catch (error) {
    if (!(error instanceof ProjectNotFoundError)) {
      const code =
        error instanceof ProjectAccessDeniedError
          ? "project_access_denied"
          : error instanceof ProjectHasActiveWorkflowError
            ? "project_has_active_workflow"
            : error instanceof ProjectDeletionIncompleteError
              ? "project_deletion_incomplete"
              : null;

      return {
        ok: false,
        error:
          (code && userErrorMessage(code)) ??
          "Could not delete project. Please try again.",
      };
    }
    // Already gone — fall through to the same redirect as a fresh success.
  }

  revalidatePath("/projects");
  redirect("/projects");
}
