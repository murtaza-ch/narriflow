import { Suspense } from "react";
import { IntegrationsScreen } from "./integrations-screen";
import IntegrationsLoading from "./loading";

// Data-free shell: accounts, key count and signing status are one scoped API read in the client screen.
export default function IntegrationsPage() {
  return (
    <Suspense fallback={<IntegrationsLoading />}>
      <IntegrationsScreen />
    </Suspense>
  );
}
