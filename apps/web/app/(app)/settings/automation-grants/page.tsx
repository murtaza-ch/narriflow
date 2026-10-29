import { Suspense } from "react";
import { GrantsScreen } from "./grants-screen";
import GrantsLoading from "./loading";

// Data-free shell: every read is a scoped API query in the client screen.
export default function AutomationGrantsPage() {
  return (
    <Suspense fallback={<GrantsLoading />}>
      <GrantsScreen />
    </Suspense>
  );
}
