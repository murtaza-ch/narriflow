"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  executeWorkspaceAction,
  executeWorkspaceActionWithInput,
  executeProjectActionWithInput,
  authenticatedActionErrorMessage,
} from "@/lib/authenticated-request-action";
import {
  projectService,
  QuotaExceededError,
  UploadTooLongError,
  LinkUnsupportedSourceError,
} from "@narriflow/services";
import {
  contentPackSchema,
  detectLinkProvider,
  hasUserErrorMessage,
  userErrorMessage,
  type ContentPack,
  type GenerationMode,
  rssImportSchema,
} from "@narriflow/validators";
import {
  readContentPackFromForm,
  readLanguageCodeFromForm,
} from "./_lib/content-pack-form";
import type { AuthenticatedActionFailure } from "@/lib/authenticated-request-action";

function readBrandTemplateIdFromForm(formData: FormData): string | null {
  const value = String(formData.get("brandTemplateId") ?? "").trim();
  return value && value !== "default" ? value : null;
}

const linkConfigureActionInputSchema = z.object({
  projectId: z.string().min(1),
  contentPack: contentPackSchema,
  languageCode: z.string().min(1).nullable(),
}).strict();

const rssActionInputSchema = rssImportSchema.extend({
  contentPack: contentPackSchema,
  languageCode: z.string().min(1).nullable(),
}).strict();

/**
 * Step 1 (Commit) error code, derived from what queueLinkIngest can throw.
 * Never thrown to the client — Next redacts thrown Server Action errors in
 * production, and the Commit CTA needs the specific, user-visible copy.
 */
function commitErrorCode(error: unknown): string {
  if (error instanceof QuotaExceededError) return "quota_exceeded";
  if (error instanceof LinkUnsupportedSourceError) {
    return "link_unsupported_source";
  }
  throw error;
}

export type CommitLinkImportResult =
  | { ok: true; projectId: string; title: string }
  | { ok: false; code: string; message: string };

async function fetchYoutubeTitle(url: string): Promise<string | null> {
  if (detectLinkProvider(url) !== "youtube") return null;

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const response = await fetch(oembedUrl, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { title?: unknown };
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    return title || null;
  } catch {
    return null;
  }
}

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
  brandProfileId: string | null;
  commitToken: string;
  languageCode: string | null;
  mode: GenerationMode;
  processingStartSec: number | null;
  processingEndSec: number | null;
}): Promise<CommitLinkImportResult> {
  return executeWorkspaceAction("processing.consume", async (appUser) => {
  try {
    const title = input.title?.trim() || (await fetchYoutubeTitle(input.url));
    const ingest = await projectService.queueLinkIngest(appUser.actorUserId, {
      url: input.url,
      title: title || undefined,
      brandTemplateId: input.brandTemplateId,
      brandProfileId: input.brandProfileId,
      commitToken: input.commitToken,
      languageCode: input.languageCode,
      mode: input.mode,
      processingStartSec: input.processingStartSec,
      processingEndSec: input.processingEndSec,
    }, appUser.workspaceId,
    );
    revalidatePath(`/projects/${ingest.project.id}`);
    return {
      ok: true,
      projectId: ingest.project.id,
      title: ingest.project.title,
    };
  } catch (error) {
    const code = commitErrorCode(error);
    return {
      ok: false,
      code,
      message:
        userErrorMessage(code) ?? "Could not start this import. Please try again.",
    };
  }
  });
}

/**
 * Step 2 (Configure) error code, derived from what finalizeGenerationSetup
 * can throw (via its internal triggerGeneration call, once ingest is
 * already ready at click time — the hard post-ingest gate).
 */
function finalizeErrorCode(error: unknown): string {
  if (error instanceof QuotaExceededError) return "quota_exceeded";
  if (error instanceof UploadTooLongError) return "ingest_max_duration_exceeded";
  throw error;
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
  return executeProjectActionWithInput(input.projectId, "content.edit", input, linkConfigureActionInputSchema, async (appUser, parsedInput) => {
  try {
    const result = await projectService.finalizeGenerationSetup(
      appUser.workspaceOwnerUserId,
      parsedInput.projectId,
      parsedInput.contentPack,
      parsedInput.languageCode,
    );
    revalidatePath(`/projects/${parsedInput.projectId}`);
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
  });
}

export type SaveGenerationDraftResult =
  { ok: true }
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
  return executeProjectActionWithInput(input.projectId, "content.edit", input, linkConfigureActionInputSchema, async (appUser, parsedInput) => {
    await projectService.saveGenerationDraft(
      appUser.workspaceOwnerUserId,
      parsedInput.projectId,
      parsedInput.contentPack,
      parsedInput.languageCode,
    );
    revalidatePath(`/projects/${parsedInput.projectId}`);
    return { ok: true };
  });
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
): Promise<{ title: string | null } | AuthenticatedActionFailure> {
  return executeWorkspaceAction("content.view", async () => {
    return { title: await fetchYoutubeTitle(url) };
  });
}

export async function generateFromRssAction(formData: FormData) {
  const rssUrl = String(formData.get("rssUrl") ?? "").trim();
  const titlePrefix = String(formData.get("titlePrefix") ?? "").trim();
  const episodeIdsRaw = String(formData.get("episodeIds") ?? "[]");
  const commitToken = String(formData.get("commitToken") ?? "").trim();
  let episodeIds: unknown = episodeIdsRaw;
  try {
    episodeIds = JSON.parse(episodeIdsRaw);
  } catch {}
  let contentPack: unknown = null;
  try {
    contentPack = readContentPackFromForm(formData);
  } catch {}
  const actionInput = {
    rssUrl,
    titlePrefix: titlePrefix || undefined,
    episodeIds,
    commitToken: commitToken || undefined,
    brandTemplateId: readBrandTemplateIdFromForm(formData),
    contentPack,
    languageCode: readLanguageCodeFromForm(formData),
  };

  return executeWorkspaceActionWithInput("processing.consume", actionInput, rssActionInputSchema, async (appUser, parsedInput) => {

  let ingest;
  try {
    ingest = await projectService.importFromRss(
      appUser.actorUserId,
      {
        rssUrl: parsedInput.rssUrl,
        titlePrefix: parsedInput.titlePrefix,
        episodeIds: parsedInput.episodeIds,
        commitToken: parsedInput.commitToken,
        brandTemplateId: parsedInput.brandTemplateId,
      },
      appUser.workspaceId,
      {
        contentPack: parsedInput.contentPack,
        languageCode: parsedInput.languageCode,
      },
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;
    if (!code || !hasUserErrorMessage(code)) throw error;
    return {
      ok: false as const,
      error: code,
      message:
        authenticatedActionErrorMessage(
          error,
          "We couldn't import that RSS episode. Check the feed and try again.",
        ),
    };
  }

  const created = ingest.projects?.[0];
  if (!created) {
    throw new Error("rss import did not produce a project");
  }

  revalidatePath(`/projects/${created.project.id}`);
  return { ok: true as const, projectId: created.project.id };
  }, {
      operationName: "generate-from-rss",
      rateLimit: {
        key: ({ workspaceId }) => `rss-import:${workspaceId}`,
        limit: 5,
        windowSeconds: 60,
      },
    });
}
