import { Suspense } from "react";
import { AutopilotScreen } from "./autopilot-screen";
import AutopilotLoading from "./loading";

// Data-free shell: the read is a scoped API query in the client screen.
export default function AutopilotPage() {
  return (
    <Suspense fallback={<AutopilotLoading />}>
      <AutopilotScreen />
    </Suspense>
  );
}
