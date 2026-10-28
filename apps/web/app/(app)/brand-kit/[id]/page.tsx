import { Suspense } from "react";
import { BrandProfileScreen } from "./profile-screen";
import BrandProfileLoading from "./loading";

// Data-free shell: the profile and its active section are one scoped aggregate read in the client screen.
export default async function BrandProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<BrandProfileLoading />}>
      <BrandProfileScreen profileId={id} />
    </Suspense>
  );
}
