import type { QueryClient } from "@tanstack/query-core";
import { ApiError } from "./error";
import { createIntent, type Intent, type IntentKeyOptions } from "./idempotency";
import { bindQueryClientToScope, createApiQueryClient } from "./query-client";
import {
  ApiScope,
  createWorkspaceHintStore,
  type HintStorage,
  type WorkspaceHintStore,
} from "./scope";
import { type ApiTransport, createApiTransport, type GetToken } from "./transport";

export interface ApiRuntimeOptions {
  /** Full API origin (`NEXT_PUBLIC_API_URL` on web). */
  baseUrl: string;
  /** Reads the *latest* session token each call; never cache its result. */
  getToken: GetToken;
  /** Where the selected-Workspace hint lives (localStorage on web). Nothing else is persisted. */
  hintStorage?: HintStorage | null;
  fetch?: typeof fetch;
  /** Navigate to the auth entry (validated return target) on an unrecoverable 401. */
  onAuthenticationFailed?: (error: ApiError) => void;
  /** Run identity bootstrap and require a fresh Workspace choice; never replay the command. */
  onWorkspaceSelectionChanged?: (error: ApiError) => void;
}

/**
 * Everything a client needs, wired once per app instance. Framework-agnostic:
 * web wraps it in a provider, Expo can build the same object with SecureStore
 * or AsyncStorage behind `hintStorage`.
 */
export interface ApiRuntime {
  readonly scope: ApiScope;
  readonly transport: ApiTransport;
  readonly queryClient: QueryClient;
  readonly hints: WorkspaceHintStore;
  /** Call when the signed-in user is known or changes (`null` on sign-out). Restores that user's hint. */
  setIdentity(userId: string | null): void;
  /** Adopts the Workspace chosen elsewhere (effective bootstrap selection, switcher, another tab). */
  selectWorkspace(workspaceId: string | null): void;
  /** Re-reads the hint (after a `storage` event) and follows it when another tab selected a Workspace. */
  syncHintFromStorage(): void;
  /** A new idempotency intent bound to the current user and Workspace. */
  createIntent<TInput>(options?: Omit<IntentKeyOptions, "scope">): Intent<TInput>;
}

export function createApiRuntime(options: ApiRuntimeOptions): ApiRuntime {
  const scope = new ApiScope();
  const queryClient = createApiQueryClient();
  bindQueryClientToScope(queryClient, scope);
  const hints = createWorkspaceHintStore(options.hintStorage ?? null);

  // The hint follows the scope: whatever Workspace is in force is the one remembered.
  scope.subscribe(({ userId, workspaceId }, transition) => {
    if (transition.kind === "workspace" && userId !== null && workspaceId !== null) {
      hints.write(userId, workspaceId);
    }
  });

  const transport = createApiTransport({
    baseUrl: options.baseUrl,
    scope,
    getToken: options.getToken,
    fetch: options.fetch,
    onAuthenticationFailed: options.onAuthenticationFailed,
    onWorkspaceSelectionChanged: options.onWorkspaceSelectionChanged,
  });

  return {
    scope,
    transport,
    queryClient,
    hints,
    setIdentity(userId) {
      scope.setUser(userId);
      if (userId !== null) scope.selectWorkspace(hints.read(userId));
    },
    selectWorkspace(workspaceId) {
      scope.selectWorkspace(workspaceId);
    },
    syncHintFromStorage() {
      const { userId } = scope.snapshot();
      if (userId === null) return;
      const hint = hints.read(userId);
      if (hint !== null) scope.selectWorkspace(hint);
    },
    createIntent<TInput>(intentOptions: Omit<IntentKeyOptions, "scope"> = {}) {
      return createIntent<TInput>({ ...intentOptions, scope });
    },
  };
}
