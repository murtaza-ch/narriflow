import { Suspense } from "react";
import Loading from "./loading";
import { ProjectsScreen } from "./_components/projects-screen";

// Data-free shell: the explorer, its folders and the filters in the URL are
// scoped API reads in the client screen. `loading.tsx` is the pending state.
export default function ProjectsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ProjectsScreen />
    </Suspense>
  );
}
