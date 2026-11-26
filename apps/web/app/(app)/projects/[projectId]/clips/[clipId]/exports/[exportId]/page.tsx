import { Suspense } from "react";
import { ExportDeliveryScreen } from "./export-delivery-screen";
import ExportDeliveryLoading from "./loading";

// Data-free shell: the ids come from the URL, and the export, its workflow cursor and
// the Workspace facts are scoped API queries in the client screen.
export default function ClipExportPage() {
  return (
    <Suspense fallback={<ExportDeliveryLoading />}>
      <ExportDeliveryScreen />
    </Suspense>
  );
}
