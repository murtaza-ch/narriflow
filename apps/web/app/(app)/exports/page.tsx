import { Suspense } from "react";
import { ExportsScreen } from "./exports-screen";
import ExportsLoading from "./loading";

// Data-free shell: the filters live in the URL and every read is a scoped API query in the client screen.
export default function ExportsPage() {
  return (
    <Suspense fallback={<ExportsLoading />}>
      <ExportsScreen />
    </Suspense>
  );
}
