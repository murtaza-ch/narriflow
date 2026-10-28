import { Suspense } from "react";
import { ChooseClipScreen } from "./choose-clip-screen";
import ChooseClipLoading from "./loading";

// Data-free shell: the clip options are a scoped API query in the client screen.
export default function NewCalendarPostPage() {
	return (
		<Suspense fallback={<ChooseClipLoading />}>
			<ChooseClipScreen />
		</Suspense>
	);
}
