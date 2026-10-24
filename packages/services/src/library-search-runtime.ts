import { getPrismaClient } from "@narriflow/db/client";
import type { ActorScope } from "./actor-scope";
import { LibrarySearch, type LibrarySearchInput } from "./library-search";
import { createOpenAiEmbeddingProvider } from "./openai-embedding-provider";
import { workspaceService } from "./workspace.service";

let librarySearch: LibrarySearch | undefined;

/** Production wiring: the app database and OpenAI embeddings. */
export function getLibrarySearch() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Library search storage is unavailable");
  librarySearch ??= new LibrarySearch({
    prisma,
    embeddings: createOpenAiEmbeddingProvider({ apiKey: process.env.OPENAI_API_KEY }),
  });
  return librarySearch;
}

export const librarySearchService = {
  /** Search for a Workspace member who can view content. */
  async search(actor: ActorScope, input: LibrarySearchInput) {
    await workspaceService.requireActor(actor.actorUserId, actor.workspaceId, "content.view");
    return getLibrarySearch().search(actor, input);
  },
};
