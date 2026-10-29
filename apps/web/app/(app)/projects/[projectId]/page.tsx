import { Suspense } from "react";
import { ProjectScreen } from "./project-screen";
import { ProjectSkeleton } from "./project-skeleton";

// Data-free shell: the Project id, tab and review handoff come from the URL, and
// the data from one detail aggregate per tab, read by the client screen.
export default function ProjectDetailPage() {
	return (
		<Suspense fallback={<ProjectSkeleton />}>
			<ProjectScreen />
		</Suspense>
	);
}
