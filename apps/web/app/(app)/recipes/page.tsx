import { Suspense } from "react";
import RecipesLoading from "./loading";
import { RecipesScreen } from "./recipes-screen";

// Data-free shell: every read is a scoped API query in the client screen.
export default function RecipesPage() {
  return (
    <Suspense fallback={<RecipesLoading />}>
      <RecipesScreen />
    </Suspense>
  );
}
