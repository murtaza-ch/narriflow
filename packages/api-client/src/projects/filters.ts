import type {
  ProjectListSortValue,
  ProjectListSourceFilterValue,
  ProjectListStatusFilterValue,
  ProjectTab,
} from "@narriflow/validators/api/projects";

/** Explorer filters as the UI holds them. Defaults ("all", "newest", no query, no folder) are omitted from keys and requests. */
export interface ProjectListFilters {
  q?: string;
  status?: ProjectListStatusFilterValue;
  source?: ProjectListSourceFilterValue;
  sort?: ProjectListSortValue;
  folder?: string;
  limit?: number;
}

/** The serializable filter object used in query keys: only non-default values, so equal filters share a cache entry. */
export function canonicalListFilters(filters: ProjectListFilters = {}) {
  const q = filters.q?.trim().slice(0, 200);
  return {
    q: q ? q : undefined,
    status: filters.status && filters.status !== "all" ? filters.status : undefined,
    source: filters.source && filters.source !== "all" ? filters.source : undefined,
    sort: filters.sort && filters.sort !== "newest" ? filters.sort : undefined,
    folder: filters.folder || undefined,
    limit: filters.limit,
  };
}

/** The query string of a list request. Values are strings, as HTTP carries them. */
export function listRequestQuery(filters: ProjectListFilters = {}, cursor?: string | null) {
  const canonical = canonicalListFilters(filters);
  return {
    ...(canonical.q ? { q: canonical.q } : {}),
    ...(canonical.status ? { status: canonical.status } : {}),
    ...(canonical.source ? { source: canonical.source } : {}),
    ...(canonical.sort ? { sort: canonical.sort } : {}),
    ...(canonical.folder ? { folder: canonical.folder } : {}),
    ...(canonical.limit !== undefined ? { limit: String(canonical.limit) } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export type { ProjectTab };
