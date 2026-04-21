"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCurrentAppUser } from "@narriflow/auth";
import { clipService, projectService } from "@narriflow/services";
import {
  contentPackSchema,
  type ClipAspectRatio,
  type ClipPlatformTarget,
  type GenerateProjectInput,
} from "@narriflow/validators";

const defaultContentPack: GenerateProjectInput["contentPack"] = {
  outputTypes: ["short_clip"],
  clipGenerationMode: "best",
  clipCountTarget: 10,
  clipDurationSecTarget: 45,
  minDurationSec: 15,
  preferredMinDurationSec: 30,
  preferredMaxDurationSec: 60,
  maxDurationSec: 90,
  platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
  autoRenderClips: false,
  toneConstraints: ["concise", "conversational"],
  captionPreset: "default",
  platformPlaybookVersion: "2026.2",
};

function readNumber(formData: FormData, key: string, fallback: number) {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function readContentPackFormData(formData: FormData) {
  const platformTargets = formData
    .getAll("platformTargets")
    .map((value) => String(value))
    .filter(Boolean) as ClipPlatformTarget[];
  const toneConstraints = String(formData.get("toneConstraints") ?? "")
    .split(",")
    .map((tone) => tone.trim())
    .filter(Boolean);

  return contentPackSchema.parse({
    ...defaultContentPack,
    clipCountTarget: readNumber(
      formData,
      "clipCountTarget",
      defaultContentPack.clipCountTarget,
    ),
    clipDurationSecTarget: readNumber(
      formData,
      "clipDurationSecTarget",
      defaultContentPack.clipDurationSecTarget,
    ),
    minDurationSec: readNumber(
      formData,
      "minDurationSec",
      defaultContentPack.minDurationSec,
    ),
    preferredMinDurationSec: readNumber(
      formData,
      "preferredMinDurationSec",
      defaultContentPack.preferredMinDurationSec,
    ),
    preferredMaxDurationSec: readNumber(
      formData,
      "preferredMaxDurationSec",
      defaultContentPack.preferredMaxDurationSec,
    ),
    maxDurationSec: readNumber(
      formData,
      "maxDurationSec",
      defaultContentPack.maxDurationSec,
    ),
    platformTargets:
      platformTargets.length > 0
        ? platformTargets
        : defaultContentPack.platformTargets,
    autoRenderClips: formData.get("autoRenderClips") === "on",
    toneConstraints:
      toneConstraints.length > 0
        ? toneConstraints
        : defaultContentPack.toneConstraints,
  });
}

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
      contentPack: readContentPackFormData(formData),
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

  await clipService.regenerateClips(
    appUser.id,
    projectId,
    idempotencyKey,
    readContentPackFormData(formData),
  );

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
