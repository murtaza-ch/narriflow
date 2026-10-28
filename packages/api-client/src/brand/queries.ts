import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type {
  BrandProfileSection,
  BrandProfilesPageQuery,
} from "@narriflow/validators/api/brand";
import { type ApiTransport, scopedKey, type WorkspaceScope } from "../core";
import { type BrandClient, createBrandClient } from "./client";

/** What a brand query needs: the shared transport and the identity + Workspace the cache entry belongs to. */
export interface BrandApi {
  transport: ApiTransport;
  scope: WorkspaceScope;
}

export function brandClientFor({ transport, scope }: BrandApi): BrandClient {
  return createBrandClient(transport.scoped(scope));
}

/** Brand configuration changes rarely; lists stay fresh for a minute. */
const CONFIGURATION_STALE_MS = 60_000;
const ACTIVE_JOB_POLL_MS = 3_000;
/** Signed links are refetched, never cached for reuse. */
const GRANT_GC_MS = 30_000;

const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "rejected",
  "cancelled",
]);

export interface AudioAssetsFilters {
  kind: "music" | "sfx";
  mood?: string;
  search?: string;
  scope?: "all" | "user";
  favorited?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Query factories of the Brand Kit. Keys are
 * `['nf', userId, workspaceId, 'brand', resource, idOrFilters]`; every
 * mutation invalidates through `invalidateBrand`, so a component only names
 * the data it wants.
 */
export function brandQueries(api: BrandApi) {
  const { scope } = api;
  const key = (resource: string, idOrFilters?: unknown) =>
    scopedKey(scope, "brand", resource, idOrFilters) as unknown[];
  const client = () => brandClientFor(api);
  const configuration = { staleTime: CONFIGURATION_STALE_MS } as const;

  return {
    /** Profiles (all of them), default, caption styles, fonts and the plan facts the Brand Kit page shows. */
    kit: () =>
      queryOptions({
        queryKey: key("kit"),
        queryFn: ({ signal }) =>
          parseResponse(client()["brand-kit"].$get(undefined, { init: { signal } })),
        ...configuration,
      }),

    /** One ordinary page of profiles. Use `kit` for every profile. */
    profiles: (filters: BrandProfilesPageQuery = {}) =>
      queryOptions({
        queryKey: key("profiles", filters),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["brand-profiles"].$get(
              { query: stringified(filters) },
              { init: { signal } },
            ),
          ),
        ...configuration,
      }),

    /** The profile new projects use. `applicable` is the one intake applies (none after a plan downgrade). */
    defaultProfile: (options: { applicable?: boolean } = {}) =>
      queryOptions({
        queryKey: key("default-profile", { applicable: options.applicable === true }),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["brand-profiles"].default.$get(
              { query: options.applicable ? { applicable: "1" } : {} },
              { init: { signal } },
            ),
          ),
        ...configuration,
      }),

    profile: (profileId: string) =>
      queryOptions({
        queryKey: key("profile", profileId),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["brand-profiles"][":id"].$get(
              { param: { id: profileId } },
              { init: { signal } },
            ),
          ),
        ...configuration,
      }),

    /** The profile plus its active section's data, usage and replacement choices. */
    profileDetail: (profileId: string, section: BrandProfileSection = "identity") =>
      queryOptions({
        queryKey: key("profile-detail", { id: profileId, section }),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["brand-profiles"][":id"].detail.$get(
              { param: { id: profileId }, query: { section } },
              { init: { signal } },
            ),
          ),
        ...configuration,
      }),

    /** What deleting the profile would affect: the default and the Recipes that name it. */
    profileUsage: (profileId: string) =>
      queryOptions({
        queryKey: key("profile-usage", profileId),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["brand-profiles"][":id"].usage.$get(
              { param: { id: profileId } },
              { init: { signal } },
            ),
          ),
        ...configuration,
      }),

    scenes: (profileId: string) =>
      queryOptions({
        queryKey: key("scenes", profileId),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["brand-profiles"][":id"]["scene-templates"].$get(
              { param: { id: profileId } },
              { init: { signal } },
            ),
          ),
        ...configuration,
      }),

    templates: () =>
      queryOptions({
        queryKey: key("templates"),
        queryFn: ({ signal }) =>
          parseResponse(client()["brand-templates"].$get(undefined, { init: { signal } })),
        ...configuration,
      }),

    template: (templateId: string) =>
      queryOptions({
        queryKey: key("template", templateId),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["brand-templates"][":id"].$get(
              { param: { id: templateId } },
              { init: { signal } },
            ),
          ),
        ...configuration,
      }),

    /** The profile a caption style belongs to, for its back link. */
    templateProfile: (templateId: string) =>
      queryOptions({
        queryKey: key("template-profile", templateId),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["brand-templates"][":id"].profile.$get(
              { param: { id: templateId } },
              { init: { signal } },
            ),
          ),
        ...configuration,
      }),

    /** Fonts a style can pick, plus the retained font it already uses, and the plan facts of its editor. */
    templateEditorAssets: (templateId: string) =>
      queryOptions({
        queryKey: key("template-editor-assets", templateId),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["brand-templates"][":id"]["editor-assets"].$get(
              { param: { id: templateId } },
              { init: { signal } },
            ),
          ),
        ...configuration,
      }),

    /** A short-lived signed link; refetched on demand and never kept. */
    templateLogoUrl: (templateId: string) =>
      queryOptions({
        queryKey: key("template-logo-url", templateId),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["brand-templates"][":id"]["logo-url"].$get(
              { param: { id: templateId } },
              { init: { signal } },
            ),
          ),
        staleTime: 0,
        gcTime: GRANT_GC_MS,
      }),

    visualAssets: () =>
      queryOptions({
        queryKey: key("visual-assets"),
        queryFn: ({ signal }) =>
          parseResponse(client()["visual-assets"].$get(undefined, { init: { signal } })),
        ...configuration,
      }),

    fonts: () =>
      queryOptions({
        queryKey: key("fonts"),
        queryFn: ({ signal }) =>
          parseResponse(client()["brand-fonts"].$get(undefined, { init: { signal } })),
        ...configuration,
      }),

    /** One page of the Music/SFX library; `nextOffset` continues it. */
    audioAssets: (filters: AudioAssetsFilters) =>
      queryOptions({
        queryKey: key("audio-assets", filters),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["audio-assets"].$get(
              { query: { ...stringified(filters), kind: filters.kind } },
              { init: { signal } },
            ),
          ),
        ...configuration,
      }),

    /** A short-lived signed playback link. */
    audioPlaybackUrl: (assetId: string) =>
      queryOptions({
        queryKey: key("audio-playback-url", assetId),
        queryFn: ({ signal }) =>
          parseResponse(
            client()["audio-assets"][":id"]["playback-url"].$get(
              { param: { id: assetId } },
              { init: { signal } },
            ),
          ),
        staleTime: 0,
        gcTime: GRANT_GC_MS,
      }),

    /** Generated images of a Project (optionally one clip) and the Workspace's image allowance. */
    generatedJobs: (projectId: string, clipId?: string) =>
      queryOptions({
        queryKey: key("generated-jobs", { projectId, clipId: clipId ?? null }),
        queryFn: ({ signal }) =>
          parseResponse(
            client().projects[":projectId"]["generated-media"].jobs.$get(
              { param: { projectId }, query: clipId ? { clipId } : {} },
              { init: { signal } },
            ),
          ),
        staleTime: 0,
        // Poll while any job can still change; stop once all are settled.
        refetchInterval: (query) =>
          query.state.data?.jobs.some((job) => !TERMINAL_JOB_STATUSES.has(job.status))
            ? ACTIVE_JOB_POLL_MS
            : false,
      }),

    /** One generated image job, polled until it settles. */
    generatedJob: (projectId: string, jobId: string) =>
      queryOptions({
        queryKey: key("generated-job", { projectId, jobId }),
        queryFn: ({ signal }) =>
          parseResponse(
            client().projects[":projectId"]["generated-media"].jobs[":id"].$get(
              { param: { projectId, id: jobId } },
              { init: { signal } },
            ),
          ),
        staleTime: 0,
        refetchInterval: (query) =>
          query.state.data && !TERMINAL_JOB_STATUSES.has(query.state.data.status)
            ? ACTIVE_JOB_POLL_MS
            : false,
      }),
  };
}

export type BrandQueries = ReturnType<typeof brandQueries>;

/** Hono's client takes query values as strings; drop unset ones and stringify the rest. */
function stringified(filters: object): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    query[name] = String(value);
  }
  return query;
}

/**
 * Brand Kit changes reach the Brand Kit's own reads and the aggregates that
 * show brand data: Recipes (brand looks), intake configuration (default
 * profile, styles) and the Studio's retained fonts/scenes/assets. Deleted
 * references stay resolvable on the server, so only reads are marked stale.
 */
export function invalidateBrand(queryClient: QueryClient, scope: WorkspaceScope): Promise<void> {
  const under = (domain: "brand" | "recipes" | "ingest" | "studio", resource?: string) =>
    queryClient.invalidateQueries({
      queryKey: scopedKey(scope, domain, resource) as unknown[],
    });
  return Promise.all([
    under("brand"),
    under("recipes"),
    under("ingest", "configuration"),
    under("studio", "editor-assets"),
    under("studio", "brand-snapshot"),
  ]).then(() => undefined);
}
