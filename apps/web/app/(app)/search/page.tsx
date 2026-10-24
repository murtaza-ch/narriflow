import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { LibrarySearch } from "./library-search";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const appUser = await admitWorkspacePage("content.view");
  const { q } = await searchParams;

  return (
    <LibrarySearch
      initialQuery={q?.slice(0, 300) ?? ""}
      canCreate={appUser.workspace.role !== "viewer" && appUser.workspace.status === "active"}
    />
  );
}
