import { Suspense } from "react";
import QueueLoading from "./loading";
import { QueueScreen } from "./queue-screen";

// Data-free shell: the queue is one scoped API read in the client screen.
export default function PublishingQueuePage() {
	return (
		<Suspense fallback={<QueueLoading />}>
			<QueueScreen />
		</Suspense>
	);
}
