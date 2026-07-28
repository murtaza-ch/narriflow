"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCurrentAppUser } from "@narriflow/auth";
import {
  clipService,
  IngestNotFailedError,
  IngestRetryLimitExceededError,
  projectService,
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

export async function createProjectFormAction(formData: FormData) {
  const appUser = await requireCurrentAppUser();
  const title = String(formData.get("title") ?? "");
  const sourceMediaUrl = String(formData.get("sourceMediaUrl") ?? "");

  const project = await projectService.createProject(appUser.id, {
    title,
    sourceMediaUrl,
  });

  revalidatePath("/projects");
  redirect(`/projects/${project.id}`);
}

export async function queueTranscriptionFormAction(formData: FormData) {
  const appUser = await requireCurrentAppUser();
  const projectId = String(formData.get("projectId") ?? "");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? randomUUID());

  if (!projectId) {
    throw new Error("projectId is required");
  }

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
  const appUser = await requireCurrentAppUser();
  const projectId = String(formData.get("projectId") ?? "");
  const idempotencyKey = String(
    formData.get("idempotencyKey") ?? randomUUID(),
  );

  if (!projectId) {
    throw new Error("projectId is required");
  }

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
  const appUser = await requireCurrentAppUser();
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

  await clipService.triggerClipRendering(
    appUser.id,
    projectId,
    idempotencyKey,
    undefined,
    aspectRatios.length > 0 ? aspectRatios : undefined,
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
  const appUser = await requireCurrentAppUser();
  const projectId = String(formData.get("projectId") ?? "");

  if (!projectId) {
    return { ok: false, error: "projectId is required" };
  }

  try {
    await projectService.retryFailedIngest(appUser.id, projectId);
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
  const appUser = await requireCurrentAppUser();
  const projectId = String(formData.get("projectId") ?? "");

  if (!projectId) {
    return { ok: false, error: "projectId is required" };
  }

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
