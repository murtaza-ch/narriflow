import { Suspense } from "react";
import NewStyleLoading from "./loading";
import { NewStyleScreen } from "./new-style-screen";

// Data-free shell: the plan boundary, fonts and editor come from the scoped Brand kit read.
export default function NewBrandTemplatePage() {
  return (
    <Suspense fallback={<NewStyleLoading />}>
      <NewStyleScreen />
    </Suspense>
  );
}
