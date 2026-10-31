import { getPrismaClient } from "@narriflow/db/client";
import { createLibraryIndex } from "./library-index";
import { createOpenAiEmbeddingProvider } from "./openai-embedding-provider";
import { readServiceEnvironment } from "./runtime-environment";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";

export function getLibraryIndex() {
  const database = getPrismaClient();
  if (!database) throw Error("Library indexing requires a database scope");
  return createLibraryIndex({ database, embeddings: createOpenAiEmbeddingProvider({ apiKey: readServiceEnvironment().OPENAI_API_KEY }),
    register: deliverExecutionDispatches, log: entry => console.warn(JSON.stringify(entry)) });
}
