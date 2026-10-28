import { Suspense } from "react";
import NewBrandProfileLoading from "./loading";
import { NewBrandProfileScreen } from "./new-profile-screen";

// Data-free shell: the plan boundary and the form come from the scoped Brand kit read.
export default function NewBrandProfilePage() {
  return (
    <Suspense fallback={<NewBrandProfileLoading />}>
      <NewBrandProfileScreen />
    </Suspense>
  );
}
