import { Suspense } from "react";
import PerformanceLoading from "./loading";
import { PerformanceScreen } from "./performance-screen";

// Data-free shell: both reads are scoped API queries in the client screen.
export default function PerformancePage() {
	return (
		<Suspense fallback={<PerformanceLoading />}>
			<PerformanceScreen />
		</Suspense>
	);
}
