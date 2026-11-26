import { Suspense } from "react";
import { BrandProfileScreen } from "./profile-screen";
import BrandProfileLoading from "./loading";

// Data-free shell: the profile id comes from the URL and the profile and its active
// section are one scoped aggregate read in the client screen.
export default function BrandProfilePage() {
  return (
    <Suspense fallback={<BrandProfileLoading />}>
      <BrandProfileScreen />
    </Suspense>
  );
}
