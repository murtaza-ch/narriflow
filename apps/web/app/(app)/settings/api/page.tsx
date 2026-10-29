import { Suspense } from "react";
import { ApiSettingsScreen } from "./api-settings-screen";
import ApiSettingsLoading from "./loading";

// Data-free shell: keys, signing status and webhooks are one scoped API read in the client screen.
export default function ApiSettingsPage() {
  return (
    <Suspense fallback={<ApiSettingsLoading />}>
      <ApiSettingsScreen />
    </Suspense>
  );
}
