import { Suspense } from "react";
import { LibrarySearch } from "./library-search";
import Loading from "./loading";

// Data-free shell: the query lives in the URL and the search is a scoped API read.
export default function SearchPage() {
  return (
    <Suspense fallback={<Loading />}>
      <LibrarySearch />
    </Suspense>
  );
}
