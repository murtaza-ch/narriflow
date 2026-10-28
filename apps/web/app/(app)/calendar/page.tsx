import { Suspense } from "react";
import { CalendarScreen } from "./calendar-screen";
import CalendarLoading from "./loading";

// Data-free shell: the view window and filters come from the URL in the client screen.
export default function CalendarPage() {
	return (
		<Suspense fallback={<CalendarLoading />}>
			<CalendarScreen />
		</Suspense>
	);
}
