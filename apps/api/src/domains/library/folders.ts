import type { workspaceLibraryService } from "@narriflow/services";

type FolderRow = Awaited<ReturnType<typeof workspaceLibraryService.listFolders>>[number];

/** The folder DTO: ISO date, and the Project count under its own name rather than Prisma's `_count`. */
export function toFolderView(folder: FolderRow) {
  return {
    id: folder.id,
    name: folder.name,
    createdAt: folder.createdAt.toISOString(),
    projectCount: folder._count.projects,
  };
}
