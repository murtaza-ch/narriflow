"use server";

import { revalidatePath } from "next/cache";
import { requireCurrentAppUser } from "@narriflow/auth";
import {
  projectService,
  QuotaExceededError,
  UploadTooLongError,
} from "@narriflow/services";
import {
  contentPackSchema,
  detectLinkProvider,
  userErrorMessage,
  type ContentPack,
  type GenerationMode,
} from "@narriflow/validators";
import {
  readContentPackFromForm,
  readLanguageCodeFromForm,
} from "./_lib/content-pack-form";

function readBrandTemplateIdFromForm(formData: FormData): string | null {
  const value = String(formData.get("brandTemplateId") ?? "").trim();
  return value && value !== "default" ? value : null;
}

/**
 * Step 1 (Commit) error code, derived from what queueLinkIngest can throw.
 * Never thrown to the client — Next redacts thrown Server Action errors in
 * production, and the Commit CTA needs the specific, user-visible copy.
 */
function commitErrorCode(error: unknown): string {
  if (error instanceof QuotaExceededError) return "quota_exceeded";
  if (error instanceof Error && error.message === "link_unsupported_source") {
    return "link_unsupported_source";
  }
  return "unknown";
}

export type CommitLinkImportResult =
  | { ok: true; projectId: string }
  | { ok: false; code: string; message: string };

/**
 * Step 1 (Commit) for the link-first split: creates the project + ingest
 * job + draft ContentPack atomically (queueLinkIngest, Phase 0), keyed by
 * the client-minted commit token so a double-submit collapses on the DB
 * unique constraint instead of racing in the UI.
 */
export async function commitLinkImportAction(input: {
  url: string;
  title: string | null;
  brandTemplateId: string | null;
  commitToken: string;
  languageCode: string | null;
  mode: GenerationMode;
  processingStartSec: number | null;
  processingEndSec: number | null;
}): Promise<CommitLinkImportResult> {
  const appUser = await requireCurrentAppUser();

  try {
    const ingest = await projectService.queueLinkIngest(appUser.id, {
      url: input.url,
      title: input.title || undefined,
      brandTemplateId: input.brandTemplateId,
      commitToken: input.commitToken,
      languageCode: input.languageCode,
      mode: input.mode,
      processingStartSec: input.processingStartSec,
      processingEndSec: input.processingEndSec,
    });
    revalidatePath(`/projects/${ingest.project.id}`);
    return { ok: true, projectId: ingest.project.id };
  } catch (error) {
    const code = commitErrorCode(error);
    return {
      ok: false,
      code,
      message:
        userErrorMessage(code) ?? "Could not start this import. Please try again.",
    };
  }
}

/**
 * Step 2 (Configure) error code, derived from what finalizeGenerationSetup
 * can throw (via its internal triggerGeneration call, once ingest is
 * already ready at click time — the hard post-ingest gate).
 */
function finalizeErrorCode(error: unknown): string {
  if (error instanceof QuotaExceededError) return "quota_exceeded";
  if (error instanceof UploadTooLongError) return "ingest_max_duration_exceeded";
  return "unknown";
}

export type FinalizeLinkConfigureResult =
  | { ok: true; started: boolean; ingestStatus: string; workflowRunId?: string }
  | { ok: false; code: string; message: string };

/**
 * Step 2 (Configure) CTA: commits the final ContentPack and attempts the
 * idempotent run-claim (Phase 0 finalizeGenerationSetup). Safe to re-invoke
 * — refresh, double-click, or the Configure step's own SSE re-fire once
 * ingest completes.
 */
export async function finalizeLinkConfigureAction(input: {
  projectId: string;
  contentPack: ContentPack;
  languageCode: string | null;
}): Promise<FinalizeLinkConfigureResult> {
  const appUser = await requireCurrentAppUser();

  try {
    // Re-validate server-side: a Server Action payload crosses the wire as
    // plain JSON, not a type-checked call — the TS param type alone doesn't
    // guarantee shape at runtime.
    const contentPack = contentPackSchema.parse(input.contentPack);
    const result = await projectService.finalizeGenerationSetup(
      appUser.id,
      input.projectId,
      contentPack,
      input.languageCode,
    );
    revalidatePath(`/projects/${input.projectId}`);
    return { ok: true, ...result };
  } catch (error) {
    const code = finalizeErrorCode(error);
    return {
      ok: false,
      code,
      message:
        userErrorMessage(code) ??
        "Could not start clip generation. Please try again.",
    };
  }
}

export type SaveGenerationDraftResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * "Save settings and finish later" (both the Step-2 failure band's link and
 * the plain CTA-area link): persists the current Step-2 form values — built
 * into a ContentPack by the same `buildLinkContentPack` the Configure CTA
 * uses — as the project's draft pack via `projectService.saveGenerationDraft`
 * (a no-op once a run already exists) instead of discarding them. A bare
 * `<Link href="/projects/...">` would navigate away without saving anything
 * the user just configured.
 */
export async function saveGenerationDraftAction(input: {
  projectId: string;
  contentPack: ContentPack;
  languageCode: string | null;
}): Promise<SaveGenerationDraftResult> {
  const appUser = await requireCurrentAppUser();

  try {
    // Re-validate server-side, same reasoning as finalizeLinkConfigureAction:
    // a Server Action payload crosses the wire as plain JSON.
    const contentPack = contentPackSchema.parse(input.contentPack);
    await projectService.saveGenerationDraft(
      appUser.id,
      input.projectId,
      contentPack,
      input.languageCode,
    );
    revalidatePath(`/projects/${input.projectId}`);
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "Could not save these settings. Please try again.",
    };
  }
}

/**
 * Server-side YouTube oEmbed lookup for the Step 1 metadata card's editable
 * title. Bounded to a ~3s timeout; any failure (timeout, non-YouTube URL,
 * oEmbed 404 for a private/deleted video) falls back silently — the title
 * field just stays editable and empty ("Link Import" is the project's own
 * fallback title server-side).
 */
export async function fetchYoutubeMetadataAction(
  url: string,
): Promise<{ title: string | null }> {
  await requireCurrentAppUser();

  if (detectLinkProvider(url) !== "youtube") {
    return { title: null };
  }

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const response = await fetch(oembedUrl, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { title: null };
    const payload = (await response.json()) as { title?: unknown };
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    return { title: title || null };
  } catch {
    return { title: null };
  }
}

export async function generateFromRssAction(formData: FormData) {
  const appUser = await requireCurrentAppUser();
  const rssUrl = String(formData.get("rssUrl") ?? "").trim();
  const titlePrefix = String(formData.get("titlePrefix") ?? "").trim();
  const episodesRaw = String(formData.get("episodes") ?? "[]");

  if (!rssUrl) {
    throw new Error("rssUrl is required");
  }

  await projectService.assertWithinQuota(appUser.id);

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
