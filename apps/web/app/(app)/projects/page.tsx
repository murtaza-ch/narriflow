import { Suspense } from "react";
import { ProjectsScreen } from "./_components/projects-screen";
import { ProjectsListLoading } from "./_components/projects-skeleton";

// Data-free shell: the explorer, its folders and the filters in the URL are
// scoped API reads in the client screen.
export default function ProjectsPage() {
  return (
    <Suspense fallback={<ProjectsListLoading />}>
      <ProjectsScreen />
    </Suspense>
  );
}
