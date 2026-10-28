import { Suspense } from "react";
import { ExportDeliveryScreen } from "./export-delivery-screen";
import ExportDeliveryLoading from "./loading";

// Data-free shell: the export, its workflow cursor and the Workspace facts are scoped API queries in the client screen.
export default async function ClipExportPage({
  params,
}: {
  params: Promise<{ projectId: string; clipId: string; exportId: string }>;
}) {
  const { projectId, clipId, exportId } = await params;
  return (
    <Suspense fallback={<ExportDeliveryLoading />}>
      <ExportDeliveryScreen projectId={projectId} clipId={clipId} exportId={exportId} />
    </Suspense>
  );
}
