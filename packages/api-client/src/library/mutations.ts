import type { QueryClient } from "@tanstack/query-core";
import { IDEMPOTENCY_KEY_HEADER, invalidateScoped, type WorkspaceScope } from "../core";
import type { LibraryClient } from "./index";

/**
 * Folder commands. Creating is a retryable create: pass the intent's key
 * (`runtime.createIntent<{ name: string }>()`) and keep it through timeouts so
 * a lost response replays the first folder instead of making a second one.
 * Rename and delete are naturally idempotent and carry no key.
 */
export const folderCommands = {
  create(client: LibraryClient, name: string, idempotencyKey: string) {
    return client.library.folders
      .$post({ json: { name } }, { headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } })
      .then((response) => response.json());
  },

  rename(client: LibraryClient, folderId: string, name: string) {
    return client.library.folders[":folderId"]
      .$patch({ param: { folderId }, json: { name } })
      .then((response) => response.json());
  },

  remove(client: LibraryClient, folderId: string) {
    return client.library.folders[":folderId"].$delete({ param: { folderId } }).then((response) => response.json());
  },
};

/** Mutations never retry on their own; spread into `useMutation` options. */
export const libraryMutationOptions = { retry: false } as const;

/** After a folder was created, renamed or deleted: the folder list and every Project list that shows folders or counts. */
export async function invalidateAfterFolderChange(queryClient: QueryClient, scope: WorkspaceScope) {
  await Promise.all([
    invalidateScoped(queryClient, scope, "library", "folders"),
    invalidateScoped(queryClient, scope, "projects", "explorer"),
    invalidateScoped(queryClient, scope, "projects", "list"),
  ]);
}
