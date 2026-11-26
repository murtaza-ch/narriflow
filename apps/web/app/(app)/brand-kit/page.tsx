import { Suspense } from "react";
import { BrandKitScreen } from "./brand-kit-screen";
import { BrandKitListLoading } from "./_components/brand-kit-list-loading";

// Data-free shell: the Brand kit is one scoped aggregate read in the client screen.
export default function BrandKitPage() {
  return (
    <Suspense fallback={<BrandKitListLoading />}>
      <BrandKitScreen />
    </Suspense>
  );
}
