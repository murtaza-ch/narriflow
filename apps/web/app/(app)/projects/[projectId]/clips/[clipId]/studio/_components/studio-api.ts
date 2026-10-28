import { type ApiRuntime, ApiError, scopedKey, type WorkspaceScope } from "@narriflow/api-client/core";
import { type StudioClient, createStudioClient } from "@narriflow/api-client/studio";
import { createProjectsClient } from "@narriflow/api-client/projects";
import { queryOptions } from "@tanstack/react-query";
import type { TranscriptUtterance } from "@narriflow/validators";
import type { BrowserRequestFailure } from "@/lib/authenticated-request-browser";

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

// ─── Bootstrap and polls (React Query owns these reads) ──────────────────────

interface ClipTarget {
  projectId: string;
  clipId: string;
}

const POLL_STALE_MS = 0;

/**
 * Query factories for the Studio's reads. The bootstrap seeds a session once:
 * it is never refetched in the background (a refetch would race the working
 * document), so focus/reconnect refetch is off and it is dropped on unmount.
 */
export function studioQueries(api: StudioApi) {
  const { scope } = api;
  const key = (resource: string, target: ClipTarget) => scopedKey(scope, "studio", resource, target) as unknown[];
  const client = () => studioClientFor(api);

  return {
    bootstrap: (target: ClipTarget) =>
      queryOptions({
        queryKey: key("bootstrap", target),
        queryFn: async ({ signal }) =>
          (
            await client().projects[":id"].clips[":clipId"].studio.$get(
              { param: { id: target.projectId, clipId: target.clipId } },
              { init: { signal } },
            )
          ).json(),
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
      }),

    previewSource: (target: ClipTarget) =>
      queryOptions({
        queryKey: key("preview-source", target),
        queryFn: async ({ signal }) =>
          (
            await client().projects[":id"].clips[":clipId"]["preview-source"].$get(
              { param: { id: target.projectId, clipId: target.clipId } },
              { init: { signal } },
            )
          ).json(),
        staleTime: POLL_STALE_MS,
        gcTime: 0,
        retry: false,
      }),

    autoLayout: (target: ClipTarget) =>
      queryOptions({
        queryKey: key("layout-auto", target),
        queryFn: async ({ signal }) =>
          (
            await client().projects[":id"].clips[":clipId"].layout.auto.$get(
              { param: { id: target.projectId, clipId: target.clipId } },
              { init: { signal } },
            )
          ).json(),
        staleTime: POLL_STALE_MS,
        gcTime: 0,
        retry: false,
      }),

    splitLayout: (target: ClipTarget) =>
      queryOptions({
        queryKey: key("layout-split", target),
        queryFn: async ({ signal }) =>
          (
            await client().projects[":id"].clips[":clipId"].layout.split.$get(
              { param: { id: target.projectId, clipId: target.clipId } },
              { init: { signal } },
            )
          ).json(),
        staleTime: POLL_STALE_MS,
        gcTime: 0,
        retry: false,
      }),

    screenLayout: (target: ClipTarget) =>
      queryOptions({
        queryKey: key("layout-screen", target),
        queryFn: async ({ signal }) =>
          (
            await client().projects[":id"].clips[":clipId"].layout.screen.$get(
              { param: { id: target.projectId, clipId: target.clipId } },
              { init: { signal } },
            )
          ).json(),
        staleTime: POLL_STALE_MS,
        gcTime: 0,
        retry: false,
      }),
  };
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
