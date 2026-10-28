import { Suspense } from "react";
import { HomeScreen } from "./home-screen";
import HomeLoading from "./loading";

// Data-free shell: the dashboard is one scoped API read in the client screen.
export default function HomePage() {
  return (
    <Suspense fallback={<HomeLoading />}>
      <HomeScreen />
    </Suspense>
  );
}
