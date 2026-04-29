"use server";

import { revalidatePath } from "next/cache";
import { requireCurrentAppUser } from "@narriflow/auth";
import { projectService } from "@narriflow/services";
import {
  readContentPackFromForm,
  readLanguageCodeFromForm,
} from "./_lib/content-pack-form";

function readBrandTemplateIdFromForm(formData: FormData): string | null {
  const value = String(formData.get("brandTemplateId") ?? "").trim();
  return value && value !== "default" ? value : null;
}

export async function generateFromUploadAction(formData: FormData) {
  const appUser = await requireCurrentAppUser();
  const projectId = String(formData.get("projectId") ?? "");

  if (!projectId) {
    throw new Error("projectId is required");
  }

  await projectService.prepareGenerationContext(
    appUser.id,
    projectId,
    readContentPackFromForm(formData),
    readLanguageCodeFromForm(formData),
  );

  revalidatePath(`/projects/${projectId}`);
  return { projectId };
}

export async function generateFromYoutubeAction(formData: FormData) {
  const appUser = await requireCurrentAppUser();
  const youtubeUrl = String(formData.get("youtubeUrl") ?? "").trim();
  const titleRaw = String(formData.get("title") ?? "").trim();

  if (!youtubeUrl) {
    throw new Error("youtubeUrl is required");
  }

  const ingest = await projectService.queueYoutubeIngest(appUser.id, {
    youtubeUrl,
    title: titleRaw || undefined,
    brandTemplateId: readBrandTemplateIdFromForm(formData),
  });

  await projectService.prepareGenerationContext(
    appUser.id,
    ingest.project.id,
    readContentPackFromForm(formData),
    readLanguageCodeFromForm(formData),
  );

  revalidatePath(`/projects/${ingest.project.id}`);
  return { projectId: ingest.project.id };
}

export async function generateFromRssAction(formData: FormData) {
  const appUser = await requireCurrentAppUser();
  const rssUrl = String(formData.get("rssUrl") ?? "").trim();
  const titlePrefix = String(formData.get("titlePrefix") ?? "").trim();
  const episodesRaw = String(formData.get("episodes") ?? "[]");

  if (!rssUrl) {
    throw new Error("rssUrl is required");
  }

  let episodes: Array<{
    id: string;
    title: string;
    enclosureUrl: string;
    publishedAt?: string | null;
    durationSeconds?: number | null;
    mimeType?: string | null;
  }> = [];
  try {
    episodes = JSON.parse(episodesRaw);
  } catch {
    throw new Error("episodes must be valid JSON");
  }

  if (!Array.isArray(episodes) || episodes.length === 0) {
    throw new Error("at least one episode is required");
  }

  const ingest = await projectService.importFromRss(appUser.id, {
    rssUrl,
    titlePrefix: titlePrefix || undefined,
    episodes,
    brandTemplateId: readBrandTemplateIdFromForm(formData),
  });

  const created = ingest.projects?.[0];
  if (!created) {
    throw new Error("rss import did not produce a project");
  }

  const contentPack = readContentPackFromForm(formData);
  const languageCode = readLanguageCodeFromForm(formData);

  for (const entry of ingest.projects) {
    await projectService.prepareGenerationContext(
      appUser.id,
      entry.project.id,
      contentPack,
      languageCode,
    );
  }

  revalidatePath(`/projects/${created.project.id}`);
  return { projectId: created.project.id };
}
