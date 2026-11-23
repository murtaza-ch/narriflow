import { Prisma, type PrismaClient } from "@prisma/client";
import { SOURCE_THUMBNAIL_VARIANTS } from "@narriflow/validators/source-thumbnail";
import { accessibleProjectSql } from "./project-access";
import { presignDownloadUrl } from "./r2-storage";

export interface ProjectThumbnailAccess {
  small: string | null;
  large: string | null;
  expiresAt: string;
}
type Project = { id: string; sourceType: string; sourceStorageKey: string | null; expiresAt: string | null };
type ThumbnailRow = { projectId: string; role: string; storageKey: string };

/** One page-wide read. Sealed images must belong to the exact owner that
 * published the Project's current source, including after retries/replacement.
 * ExecutionArtifact is already the durable object ledger and retention owner. */
export async function readProjectThumbnails(
  database: Pick<PrismaClient, "$queryRaw">,
  workspaceId: string,
  projects: readonly Project[],
  sign: typeof presignDownloadUrl = presignDownloadUrl,
) {
  const eligible = projects.filter((project) => project.sourceType === "upload" && project.sourceStorageKey);
  const result = new Map<string, ProjectThumbnailAccess>();
  if (eligible.length === 0) return result;
  const rows = await database.$queryRaw<ThumbnailRow[]>(Prisma.sql`
    SELECT DISTINCT ON (p.id, image.role) p.id AS "projectId", image.role, image."storageKey"
    FROM "Project" p
    JOIN "IngestJob" job ON job."projectId" = p.id AND job."sourceRevision" = p."sourceRevision"
    JOIN "ExecutionDispatch" dispatch ON dispatch."subjectKind" = 'ingest_job' AND dispatch."subjectId" = job.id::text
    JOIN "ExecutionAttempt" attempt ON attempt."dispatchId" = dispatch.id
    JOIN "ExecutionArtifact" video ON video."attemptToken" = attempt."attemptToken"
      AND video.role = 'source_video' AND video."storageKey" = p."sourceStorageKey" AND video."committedAt" IS NOT NULL
    JOIN "ExecutionArtifact" image ON image."attemptToken" = video."attemptToken" AND image.owner = video.owner
      AND image."committedAt" IS NOT NULL AND image."contentType" = 'image/webp'
      AND image.role IN ('source_thumbnail_small', 'source_thumbnail_large')
    WHERE p."workspaceId" = ${workspaceId}::uuid AND p.id IN (${Prisma.join(eligible.map((project) => Prisma.sql`${project.id}::uuid`))})
      AND p."sourceType" = 'upload' AND ${accessibleProjectSql("p")}
    ORDER BY p.id, image.role, image."committedAt" DESC, image.id DESC`);
  const now = Date.now();
  await Promise.all(eligible.map(async (project) => {
    const images = rows.filter((row) => row.projectId === project.id);
    if (images.length === 0) return;
    const expiresIn = Math.min(3600, project.expiresAt ? Math.floor((Date.parse(project.expiresAt) - now) / 1000) : 3600);
    if (expiresIn < 1) return;
    const urls = await Promise.all(SOURCE_THUMBNAIL_VARIANTS.map(async ({ role }) => {
      const image = images.find((row) => row.role === role);
      if (!image) return null;
      try {
        return await sign({ key: image.storageKey, expiresIn, cacheControl: `private, max-age=${Math.min(300, expiresIn)}` });
      } catch {
        console.warn(JSON.stringify({ level: "warn", message: "project_thumbnail_access_unavailable", projectId: project.id }));
        return null;
      }
    }));
    if (urls.some(Boolean)) result.set(project.id, { small: urls[0] ?? null, large: urls[1] ?? null, expiresAt: new Date(now + expiresIn * 1000).toISOString() });
  }));
  return result;
}
