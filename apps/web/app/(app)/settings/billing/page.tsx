import { Suspense } from "react";
import { BillingScreen } from "./billing-screen";
import BillingLoading from "./loading";

// Data-free shell: every read is a scoped API query in the client screen.
export default function BillingPage() {
  return (
    <Suspense fallback={<BillingLoading />}>
      <BillingScreen />
    </Suspense>
  );
}
