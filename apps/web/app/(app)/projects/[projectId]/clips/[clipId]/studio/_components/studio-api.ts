import { type ApiRuntime, ApiError, type Intent, type WorkspaceScope } from "@narriflow/api-client/core";
import { clipCommands, createClipsClient } from "@narriflow/api-client/clips";
import { createExportsClient } from "@narriflow/api-client/exports";
import {
  type StudioClient,
  type StudioClipTarget,
  createStudioClient,
  studioQueries as domainStudioQueries,
} from "@narriflow/api-client/studio";
import { createProjectsClient } from "@narriflow/api-client/projects";
import type { TranscriptUtterance } from "@narriflow/validators";
import type { BrowserRequestFailure } from "@/lib/authenticated-request-browser";
import { projectGateDestination } from "../../../../project-load-error";

/**
 * Studio transport. The Editing Session keeps drafts, history, revision
 * barriers, cross-tab write ownership and cloud convergence; this module only
 * supplies the HTTP adapters it is given and the bootstrap/poll reads React
 * Query owns. Nothing here observes the working document or saves it.
 */

/** The identity + Workspace a Studio request belongs to, with the shared runtime. */
export interface StudioApi {
  readonly runtime: ApiRuntime;
  readonly scope: WorkspaceScope;
}

/** For handlers that run after the page gate: a missing scope is a refused request, not a crash. */
export function requireStudioApi(api: StudioApi | null): StudioApi {
  if (!api) throw new Error("Select a Workspace to continue.");
  return api;
}

export function studioClientFor(api: StudioApi): StudioClient {
  return createStudioClient(api.runtime.transport.scoped(api.scope));
}

/**
 * The error envelope fields components branch on (`error`/`code`, `message`,
 * `details`), rebuilt from a typed `ApiError`. Anything else is a failure
 * without an envelope (offline, aborted).
 */
export function apiFailureBody(error: unknown): BrowserRequestFailure {
  if (!(error instanceof ApiError)) return {};
  return {
    ok: false,
    error: error.code,
    code: error.code,
    message: error.message,
    ...(error.requestId ? { requestId: error.requestId } : {}),
    ...(error.details ? { details: { ...error.details } } : {}),
    ...(error.issues.length > 0
      ? { issues: error.issues.map((issue) => ({ path: [...issue.path], code: issue.code, message: issue.message })) }
      : {}),
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  };
}

export function apiFailureStatus(error: unknown): number | null {
  return error instanceof ApiError && error.status > 0 ? error.status : null;
}

// ─── Admission failures ──────────────────────────────────────────────────────

const MISSING_CODES: ReadonlySet<string> = new Set(["project_not_found", "clip_not_found"]);

export type StudioBootstrapFailure =
  | { kind: "redirect"; to: string }
  | { kind: "missing" }
  | { kind: "error" };

/**
 * What a refused Studio bootstrap does. Admission refusals leave exactly as the
 * Project page does (another Workspace, a paused one, or a viewer without
 * `content.edit` going home with the safe failure parameters); a missing
 * Project or clip is the app's not-found page; anything else is an error.
 */
export function studioBootstrapFailure(error: unknown, projectId: string): StudioBootstrapFailure {
  const to = projectGateDestination(error, projectId, "studio");
  if (to) return { kind: "redirect", to };
  const body = apiFailureBody(error);
  if (apiFailureStatus(error) === 404 || (body.error && MISSING_CODES.has(body.error))) return { kind: "missing" };
  return { kind: "error" };
}

// ─── Seed and presentation ───────────────────────────────────────────────────

/**
 * The frozen seed's clip facts with the title the API currently reports. The
 * Editing Session's document is seeded once, but the title is presentation:
 * a rename from the Studio's own menu invalidates the bootstrap and must show.
 * Returns `seed` itself while the title is unchanged, so props stay stable.
 */
export function withLiveClipTitle<T extends { clipTitle: string | null }>(seed: T, latest: T | undefined): T {
  if (!latest || latest.clipTitle === seed.clipTitle) return seed;
  return { ...seed, clipTitle: latest.clipTitle };
}

// ─── Export ──────────────────────────────────────────────────────────────────

/** What one Export click sends; also the fingerprint of its idempotency intent. */
export interface StudioExportInput {
  projectId: string;
  clipId: string;
  expectedRevision: number;
  aspectRatios: Array<"9:16" | "1:1" | "16:9" | "4:5">;
  resolution: "720p" | "1080p";
}

/**
 * One Export intent: the same Idempotency-Key through retries and lost
 * responses until the API confirms acceptance, so a retry replays the original
 * receipt. A changed revision/format/resolution is a new intent.
 */
export async function createStudioExport(
  api: StudioApi,
  intent: Intent<StudioExportInput>,
  input: StudioExportInput,
): Promise<{ export: { id: string } }> {
  const { projectId, clipId, ...json } = input;
  const response = await createExportsClient(api.runtime.transport.scoped(api.scope)).projects[":id"].clips[
    ":clipId"
  ].exports.$post(
    { param: { id: projectId, clipId }, json },
    { headers: { "Idempotency-Key": intent.keyFor(input) } },
  );
  const created = (await response.json()) as { export: { id: string } };
  intent.complete();
  return created;
}

/** One "Create clip from selection" press; also the fingerprint of its idempotency intent. */
export interface StudioSelectionClipInput {
  projectId: string;
  clipId: string;
  startSec: number;
  endSec: number;
}

/** Same intent contract as Export: a retry after a lost response returns the clip already created. */
export async function createClipFromStudioSelection(
  api: StudioApi,
  intent: Intent<StudioSelectionClipInput>,
  input: StudioSelectionClipInput,
): Promise<unknown> {
  const { projectId, clipId, ...range } = input;
  const created = await clipCommands.createFromSelection(
    createClipsClient(api.runtime.transport.scoped(api.scope)),
    projectId,
    clipId,
    range,
    intent.keyFor(input),
  );
  intent.complete();
  return created;
}

// ─── Bootstrap and polls (React Query owns these reads) ──────────────────────

type ClipTarget = StudioClipTarget;

/** The Studio's reads, from the API client's Studio queries (see there for the bootstrap's no-refetch contract). */
export function studioQueries(api: StudioApi) {
  return domainStudioQueries(api.runtime.transport, api.scope);
}

/** Closures the shell's bounded polling loops call; each is one fresh cached fetch. */
export function studioPollers(api: StudioApi, target: ClipTarget) {
  const queries = studioQueries(api);
  const { queryClient } = api.runtime;
  return {
    fetchPreviewStatus: () => queryClient.fetchQuery(queries.previewSource(target)),
    fetchAutoLayoutAnalysis: async () => (await queryClient.fetchQuery(queries.autoLayout(target))).analysis,
    fetchSplitLayoutAnalysis: async () => (await queryClient.fetchQuery(queries.splitLayout(target))).outcome,
    fetchScreenLayoutAnalysis: async () => (await queryClient.fetchQuery(queries.screenLayout(target))).outcome,
  };
}

// ─── Project censor terms and analytics ──────────────────────────────────────

export async function replaceProjectCensorTerms(
  api: StudioApi,
  projectId: string,
  terms: string[],
): Promise<{ terms: string[] }> {
  const response = await studioClientFor(api).projects[":id"]["censor-terms"].$put({
    param: { id: projectId },
    json: { terms },
  });
  return response.json();
}

export async function recordCensorEvent(
  api: StudioApi,
  target: ClipTarget,
  input: Parameters<StudioClient["projects"][":id"]["clips"][":clipId"]["censor-events"]["$post"]>[0]["json"],
): Promise<void> {
  await studioClientFor(api).projects[":id"].clips[":clipId"]["censor-events"].$post({
    param: { id: target.projectId, clipId: target.clipId },
    json: input,
  });
}

// ─── Cache-backed reads for the Trim/Extend and waveform helpers ────────────

/** Cache namespace of one identity + Workspace, so module-level caches never cross accounts. */
export function studioCacheScope(scope: WorkspaceScope): string {
  return `${scope.userId}:${scope.workspaceId}`;
}

/** The project's raw utterances for the Trim/Extend editor. */
export async function fetchProjectUtterances(
  api: StudioApi,
  projectId: string,
  signal?: AbortSignal,
): Promise<TranscriptUtterance[]> {
  const client = createProjectsClient(api.runtime.transport.scoped(api.scope));
  const response = await client.projects[":id"].transcript.utterances.$get(
    { param: { id: projectId } },
    signal ? { init: { signal } } : undefined,
  );
  const body = (await response.json()) as { utterances?: TranscriptUtterance[] };
  return body.utterances ?? [];
}

/**
 * One preview peaks artifact. `path` is the API-relative URL the preview source
 * returns (`/api/projects/:id/clips/:clipId/preview-peaks?v=`); the bound
 * transport resolves it against the API origin and adds the Bearer token, which
 * a plain fetch could not. Resolves null when the preview has none (204).
 */
export async function fetchPreviewPeaks(
  api: StudioApi,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await api.runtime.transport.scoped(api.scope).fetch(path, signal ? { signal } : {});
  return response.status === 204 ? null : response.json();
}

/**
 * The reads module-level caches (trim transcript, waveform peaks) are filled
 * from. `cacheScope` namespaces those caches by identity + Workspace.
 */
export interface StudioReads {
  readonly cacheScope: string;
  utterances(projectId: string): Promise<TranscriptUtterance[]>;
  peaks(path: string): Promise<unknown>;
}

export function studioReads(api: StudioApi): StudioReads {
  return {
    cacheScope: studioCacheScope(api.scope),
    utterances: (projectId) => fetchProjectUtterances(api, projectId),
    peaks: (path) => fetchPreviewPeaks(api, path),
  };
}
