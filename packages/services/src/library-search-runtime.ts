import { readServiceEnvironment } from "./runtime-environment";
import { getPrismaClient } from "@narriflow/db/client";
import type { ActorScope } from "./actor-scope";
import { LibrarySearch, type LibrarySearchInput } from "./library-search";
import { createOpenAiEmbeddingProvider } from "./openai-embedding-provider";
import { workspaceService } from "./workspace.service";


/** Production wiring: the app database and OpenAI embeddings. */
export function getLibrarySearch() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Library search storage is unavailable");
  return new LibrarySearch({
    prisma,
    embeddings: createOpenAiEmbeddingProvider({ apiKey: readServiceEnvironment().OPENAI_API_KEY }),
  });
}

export const librarySearchService = {
  /** Search for a Workspace member who can view content. */
  async search(actor: ActorScope, input: LibrarySearchInput) {
    await workspaceService.requireActor(actor.actorUserId, actor.workspaceId, "content.view");
    return getLibrarySearch().search(actor, input);
  },
};
