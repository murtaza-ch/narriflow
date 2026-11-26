import { Suspense } from "react";
import EditStyleLoading from "./loading";
import { EditStyleScreen } from "./style-screen";

// Data-free shell: the style id comes from the URL, and the style, its profile and
// its fonts are scoped API reads in the client screen.
export default function EditBrandTemplatePage() {
  return (
    <Suspense fallback={<EditStyleLoading />}>
      <EditStyleScreen />
    </Suspense>
  );
}
