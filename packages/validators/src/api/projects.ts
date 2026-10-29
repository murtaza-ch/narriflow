import { z } from "zod";
import { brandProfileProjectApplicationSchema } from "../brand-profile";
import { transcriptExportFormatSchema } from "../transcript";

/** Project detail tabs; `clips` is the default for anything unrecognised. */
export const PROJECT_TABS = [
  "clips",
  "transcript",
  "repurpose",
  "dubbing",
  "review",
  "posts",
  "analytics",
  "activity",
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export function projectTabFromSearchParam(value: string | null | undefined): ProjectTab {
  return value && (PROJECT_TABS as readonly string[]).includes(value) ? (value as ProjectTab) : "clips";
}

export const PROJECT_LIST_STATUS_FILTERS = ["all", "ready", "processing", "queued", "failed"] as const;
export const PROJECT_LIST_SOURCE_FILTERS = ["all", "youtube", "link", "upload", "rss"] as const;
export const PROJECT_LIST_SORTS = ["newest", "oldest", "title", "clips"] as const;
export type ProjectListStatusFilterValue = (typeof PROJECT_LIST_STATUS_FILTERS)[number];
export type ProjectListSourceFilterValue = (typeof PROJECT_LIST_SOURCE_FILTERS)[number];
export type ProjectListSortValue = (typeof PROJECT_LIST_SORTS)[number];

/** A closed filter: anything unrecognised means the default, as the Projects page always did. */
function lenientChoice<const T extends readonly [string, ...string[]]>(choices: T, fallback: T[number]) {
  return z
    .string()
    .optional()
    .transform((value): T[number] => (value !== undefined && (choices as readonly string[]).includes(value) ? (value as T[number]) : fallback));
}

const lenientLimit = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  });

/** Query shared by `GET /api/projects` and `GET /api/projects/explorer`: filters, sort, folder, page size and cursor. */
export const projectListQuerySchema = z.object({
  q: z
    .string()
    .optional()
    .transform((value) => value?.trim().slice(0, 200) ?? ""),
  status: lenientChoice(PROJECT_LIST_STATUS_FILTERS, "all"),
  source: lenientChoice(PROJECT_LIST_SOURCE_FILTERS, "all"),
  sort: lenientChoice(PROJECT_LIST_SORTS, "newest"),
  folder: z
    .string()
    .max(64)
    .optional()
    .transform((value) => value || undefined),
  limit: lenientLimit,
  cursor: z
    .string()
    .max(512)
    .optional()
    .transform((value) => value || null),
});
export type ProjectListQuery = z.output<typeof projectListQuerySchema>;

/** `GET /api/projects/:id/detail?tab=`: the tab whose data the aggregate also carries. */
/** `GET /projects/:id/transcript/export`: the file format, text by default. */
export const transcriptExportQuerySchema = z.object({
  format: transcriptExportFormatSchema.default("txt"),
});

export const projectDetailQuerySchema = z.object({
  tab: z
    .string()
    .optional()
    .transform((value) => projectTabFromSearchParam(value)),
});

/** `GET /api/projects/:id/transcript?view=`: the full transcript, or only its status for the shell. */
export const transcriptViewQuerySchema = z.object({
  view: z.enum(["full", "status"]).default("full"),
});

/** `POST /api/projects/:id/brand-profile`; the Project comes from the path. */
export const applyProjectBrandProfileRequestSchema = brandProfileProjectApplicationSchema.omit({ projectId: true });
export type ApplyProjectBrandProfileRequest = z.infer<typeof applyProjectBrandProfileRequestSchema>;

/** `PUT /api/projects/:id/notify-preference`. */
export const notifyPreferenceRequestSchema = z.object({ notifyOnComplete: z.boolean() }).strict();
export type NotifyPreferenceRequest = z.infer<typeof notifyPreferenceRequestSchema>;
