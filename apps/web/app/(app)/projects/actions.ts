"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCurrentAppUser } from "@narriflow/auth";
import { clipService, projectService } from "@narriflow/services";
import type { ClipAspectRatio, GenerateProjectInput } from "@narriflow/validators";

const defaultContentPack: GenerateProjectInput["contentPack"] = {
  outputTypes: ["short_clip"],
  clipCountTarget: 3,
  clipDurationSecTarget: 30,
  toneConstraints: ["concise", "conversational"],
  captionPreset: "default",
  platformPlaybookVersion: "2026.2",
};

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

  await projectService.triggerGeneration(
    appUser.id,
    projectId,
    {
      contentPack: defaultContentPack,
      forceRegenerate: false,
    },
    idempotencyKey,
  );

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

  await clipService.regenerateClips(appUser.id, projectId, idempotencyKey);

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
