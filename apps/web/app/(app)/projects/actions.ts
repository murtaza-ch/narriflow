"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { projectService } from "@clipforge/services";
import type { GenerateProjectInput } from "@clipforge/validators";

const defaultContentPack: GenerateProjectInput["contentPack"] = {
  outputTypes: ["short_clip"],
  clipCountTarget: 3,
  clipDurationSecTarget: 30,
  toneConstraints: ["concise", "conversational"],
  captionPreset: "default",
  platformPlaybookVersion: "2026.1",
};

export async function createProjectFormAction(formData: FormData) {
  const title = String(formData.get("title") ?? "");
  const sourceMediaUrl = String(formData.get("sourceMediaUrl") ?? "");

  const project = await projectService.createProject({
    title,
    sourceMediaUrl,
  });

  revalidatePath("/projects");
  redirect(`/projects/${project.id}`);
}

export async function queueGenerationFormAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? randomUUID());

  if (!projectId) {
    throw new Error("projectId is required");
  }

  await projectService.triggerGeneration(
    projectId,
    {
      contentPack: defaultContentPack,
      forceRegenerate: false,
    },
    idempotencyKey,
  );

  revalidatePath(`/projects/${projectId}`);
}
