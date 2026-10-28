import { Suspense } from "react";
import EditStyleLoading from "./loading";
import { EditStyleScreen } from "./style-screen";

// Data-free shell: the style, its profile and its fonts are scoped API reads in the client screen.
export default async function EditBrandTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<EditStyleLoading />}>
      <EditStyleScreen templateId={id} />
    </Suspense>
  );
}
