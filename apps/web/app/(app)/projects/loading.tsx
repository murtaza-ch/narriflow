import { PageHeader } from "@narriflow/ui/components/page-header";
import { LoadingScreen } from "@narriflow/ui/components/page-loading";
import { ProjectsGridSkeleton } from "./_components/projects-skeleton";

/**
 * The page's own static shell — the same root, the same header fallback and
 * the same grid skeleton as page.tsx's Suspense fallbacks — so the handoff
 * from this route boundary to the in-page one doesn't repaint anything.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading projects">
      <PageHeader title="Projects" />
      <ProjectsGridSkeleton />
    </LoadingScreen>
  );
}
