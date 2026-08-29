"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  executeWorkspaceAction,
  executeProjectAction,
  authenticatedActionResultError,
} from "@/lib/authenticated-request-action";
import {
	clipService,
	IngestNotFailedError,
	IngestRetryLimitExceededError,
	ProjectAccessDeniedError,
	ProjectDeletionIncompleteError,
	ProjectHasActivePublicationError,
	ProjectHasActiveWorkflowError,
	ProjectNotFoundError,
	projectService,
	workspaceLibraryService,
	QuotaExceededError,
	UploadTooLongError,
} from "@narriflow/services";
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
		return await executeWorkspaceAction("content.edit", async (appUser) => {
			try {
				const folder = await workspaceLibraryService.createFolder(
					appUser.actorUserId,
					appUser.workspaceId,
					name,
				);
				revalidatePath("/projects");
				return {
					ok: true as const,
					folder: { ...folder, createdAt: folder.createdAt.toISOString() },
				};
			} catch (error) {
				const failure = authenticatedActionResultError(
					error,
					"Folder creation failed",
				);
				return {
					ok: false as const,
					error: failure.message,
					errorCode: failure.errorCode,
					requestId: failure.requestId,
				};
			}
		});
	} catch (error) {
    const failure = authenticatedActionResultError(
      error,
      "Folder creation failed",
    );
		return {
			ok: false as const,
			error: failure.message,
      errorCode: failure.errorCode,
      requestId: failure.requestId,
		};
	}
}

export async function deleteFolderAction(folderId: string) {
	return executeWorkspaceAction("content.edit", async (appUser) => {
		await workspaceLibraryService.deleteFolder(
			appUser.actorUserId,
			appUser.workspaceId,
			folderId,
		);
		revalidatePath("/projects");
	});
}

export async function renameFolderAction(folderId: string, name: string) {
	try {
		return await executeWorkspaceAction("content.edit", async (appUser) => {
			try {
				await workspaceLibraryService.renameFolder(
					appUser.actorUserId,
					appUser.workspaceId,
					folderId,
					name,
				);
				revalidatePath("/projects");
				return { ok: true as const };
			} catch (error) {
				const failure = authenticatedActionResultError(
					error,
					"Folder rename failed",
				);
				return {
					ok: false as const,
					error: failure.message,
					errorCode: failure.errorCode,
					requestId: failure.requestId,
				};
			}
		});
	} catch (error) {
    const failure = authenticatedActionResultError(
      error,
      "Folder rename failed",
    );
		return {
			ok: false as const,
			error: failure.message,
      errorCode: failure.errorCode,
      requestId: failure.requestId,
		};
	}
}

export async function moveProjectToFolderAction(
	projectId: string,
	folderId: string | null,
) {
	return executeProjectAction(projectId, "content.edit", async (appUser) => {
		await workspaceLibraryService.moveProject(
			appUser.actorUserId,
			appUser.workspaceId,
			projectId,
			folderId,
		);
		revalidatePath("/projects");
	});
}

export async function createProjectFormAction(formData: FormData) {
	return executeWorkspaceAction("content.edit", async (appUser) => {
	const title = String(formData.get("title") ?? "");
	const sourceMediaUrl = String(formData.get("sourceMediaUrl") ?? "");

	const project = await projectService.createProject(
		appUser.actorUserId,
		{
			title,
			sourceMediaUrl,
		},
		appUser.workspaceId,
	);

	revalidatePath("/projects");
	redirect(`/projects/${project.id}`);
	});
}

export async function queueTranscriptionFormAction(formData: FormData) {
	const projectId = String(formData.get("projectId") ?? "");
	const idempotencyKey = String(formData.get("idempotencyKey") ?? randomUUID());

	if (!projectId) {
		throw new Error("projectId is required");
	}
	return executeProjectAction(
		projectId,
		"processing.consume",
		async (appUser) => {

	try {
		await projectService.triggerGeneration(
			appUser.workspaceOwnerUserId,
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
	},
);
}

export const queueGenerationFormAction = queueTranscriptionFormAction;

export async function regenerateClipsFormAction(formData: FormData) {
	const projectId = String(formData.get("projectId") ?? "");
	const idempotencyKey = String(formData.get("idempotencyKey") ?? randomUUID());

	if (!projectId) {
		throw new Error("projectId is required");
	}
	return executeProjectAction(
		projectId,
		"processing.consume",
		async (appUser) => {

	try {
		await clipService.regenerateClips(
			projectId,
			idempotencyKey,
			readContentPackFromForm(formData),
			{
				workspaceId: appUser.workspaceId,
				actorUserId: appUser.actorUserId,
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
	},
);
}

export async function renderClipsFormAction(formData: FormData) {
	const projectId = String(formData.get("projectId") ?? "");
	const idempotencyKey = String(formData.get("idempotencyKey") ?? randomUUID());
	const aspectRatios = formData
		.getAll("aspectRatios")
		.map((value) => String(value))
		.filter(Boolean) as ClipAspectRatio[];

	if (!projectId) {
		throw new Error("projectId is required");
	}
	return executeProjectAction(
		projectId,
		"processing.consume",
		async (appUser) => {

	await clipService.triggerClipRendering(
		projectId,
		idempotencyKey,
		{
			workspaceId: appUser.workspaceId,
			actorUserId: appUser.actorUserId,
		},
		undefined,
		aspectRatios.length > 0 ? aspectRatios : undefined,
		"1080p",
	);

	revalidatePath(`/projects/${projectId}`);
	},
);
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
	return executeProjectAction(
		projectId,
		"processing.consume",
		async (appUser) => {

	try {
		await projectService.retryFailedIngest(appUser.workspaceOwnerUserId, projectId, {
			workspaceId: appUser.workspaceId,
			actorUserId: appUser.actorUserId,
		},
    );
	} catch (error) {
		const code =
			error instanceof IngestRetryLimitExceededError
				? "ingest_retry_limit_exceeded"
				: error instanceof IngestNotFailedError
					? "ingest_not_failed"
					: null;
		if (!code) throw error;

		return {
			ok: false,
			error:
				(code && userErrorMessage(code)) ??
				"Could not retry ingest. Please try again.",
		};
	}

	revalidatePath(`/projects/${projectId}`);
	return { ok: true };
	},
);
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
	return executeProjectAction(projectId, "content.edit", async (appUser) => {
	try {
		await projectService.setProjectNotifyPreference(
			appUser.workspaceOwnerUserId,
			projectId,
			notifyOnComplete,
		);
	} catch (error) {
		if (!(error instanceof ProjectNotFoundError)) throw error;
		return {
			ok: false,
			error: "Could not save this preference. Please try again.",
		};
	}

	return { ok: true };
	});
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
	return executeProjectAction(projectId, "content.edit", async (appUser) => {
	try {
		await projectService.deleteProject(appUser.workspaceOwnerUserId, projectId);
	} catch (error) {
		if (!(error instanceof ProjectNotFoundError)) {
			const code =
				error instanceof ProjectAccessDeniedError
					? "project_access_denied"
					: error instanceof ProjectHasActiveWorkflowError
						? "project_has_active_workflow"
						: error instanceof ProjectHasActivePublicationError
							? "project_has_active_publication"
							: error instanceof ProjectDeletionIncompleteError
								? "project_deletion_incomplete"
								: null;

			if (!code) throw error;
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
	});
}
