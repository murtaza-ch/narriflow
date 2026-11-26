"use client";

import { usePathname } from "next/navigation";
import StudioLayout from "../[projectId]/clips/[clipId]/studio/layout";
import StudioLoading from "../[projectId]/clips/[clipId]/studio/loading";
import ExportDeliveryLoading from "../[projectId]/clips/[clipId]/exports/[exportId]/loading";
import { ProjectSkeleton } from "../[projectId]/project-skeleton";
import { ProjectsListLoading } from "./projects-skeleton";

export type ProjectsRoute = "list" | "project" | "studio" | "export";

/** Which page under /projects a pathname opens. */
export function projectsRouteFor(pathname: string): ProjectsRoute {
  const [, projectId, clips, , page] = pathname.split("/").filter(Boolean);
  if (!projectId) return "list";
  if (clips === "clips" && page === "studio") return "studio";
  if (clips === "clips" && page === "exports") return "export";
  return "project";
}

/**
 * The loading state of every page under /projects. A route's loading.tsx also
 * wraps the routes below it, and Next shows the outermost one above a
 * dynamic segment first: opening a project (hard load or link) used to flash
 * the Projects list skeleton, then jump to the project's. So the boundaries
 * at /projects and /projects/[projectId] both show the skeleton of the page
 * being opened.
 */
export function ProjectsRouteLoading() {
  const route = projectsRouteFor(usePathname() ?? "");
  switch (route) {
    case "list":
      return <ProjectsListLoading />;
    case "project":
      return <ProjectSkeleton />;
    case "studio":
      return (
        <StudioLayout>
          <StudioLoading />
        </StudioLayout>
      );
    case "export":
      return <ExportDeliveryLoading />;
  }
}
