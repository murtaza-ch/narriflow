import { scopeChangedError } from "./error";

/** The identity and selected Workspace every first-party request is bound to. */
export interface ClientScope {
  readonly userId: string | null;
  readonly workspaceId: string | null;
}

/** A scope plus a counter that moves on every change, so A -> B -> A is still a change. */
export interface ScopeSnapshot extends ClientScope {
  readonly version: number;
}

export type ScopeTransition =
  | { kind: "user"; previous: ClientScope; next: ClientScope }
  | { kind: "workspace"; previous: ClientScope; next: ClientScope };

/** What an in-flight request is bound to. `workspaceId: null` means identity-only. */
export interface ScopeTarget {
  readonly userId: string;
  readonly workspaceId: string | null;
}

export interface TrackedRequest {
  /** Aborts when the caller aborts or the scope changes under the request. */
  readonly signal: AbortSignal;
  /** True only when the abort was caused by a scope change. */
  readonly scopeAborted: boolean;
  release(): void;
}

type TransitionHandler = (transition: ScopeTransition) => void;
type ScopeListener = (snapshot: ScopeSnapshot, transition: ScopeTransition) => void;

interface Entry {
  target: ScopeTarget;
  controller: AbortController;
  scopeAborted: boolean;
}

function logHandlerFailure(error: unknown): void {
  console.warn(
    JSON.stringify({
      level: "error",
      message: "api scope handler failed",
      error: error instanceof Error ? error.name : "unknown",
    }),
  );
}

/**
 * Single owner of "which user and Workspace is this tab acting as". The scope
 * changes only through `setUser` (sign-in/out, account switch) or
 * `selectWorkspace`; either one first aborts the requests it invalidates, then
 * runs `onBeforeChange` handlers (cache cancel/clear), then moves, then
 * notifies subscribers. Nothing here reads cookies, storage or Clerk.
 */
export class ApiScope {
  #snapshot: ScopeSnapshot = { userId: null, workspaceId: null, version: 0 };
  readonly #inflight = new Set<Entry>();
  readonly #beforeChange = new Set<TransitionHandler>();
  readonly #listeners = new Set<ScopeListener>();

  /** Stable between changes, so it can back `useSyncExternalStore`. */
  snapshot(): ScopeSnapshot {
    return this.#snapshot;
  }

  /** Returns false (and does nothing) when the user is unchanged. */
  setUser(userId: string | null): boolean {
    const previous = this.#snapshot;
    if (previous.userId === userId) return false;
    this.#move({ kind: "user", previous, next: { userId, workspaceId: null } });
    return true;
  }

  /** Needs a user; returns false when nothing changes or nobody is signed in. */
  selectWorkspace(workspaceId: string | null): boolean {
    const previous = this.#snapshot;
    if (previous.userId === null || previous.workspaceId === workspaceId) return false;
    this.#move({
      kind: "workspace",
      previous,
      next: { userId: previous.userId, workspaceId },
    });
    return true;
  }

  /** True while `target` is still the user (and Workspace, when scoped) in force. */
  isCurrent(target: ScopeTarget): boolean {
    const { userId, workspaceId } = this.#snapshot;
    if (userId !== target.userId) return false;
    return target.workspaceId === null || workspaceId === target.workspaceId;
  }

  /** Runs synchronously after in-flight requests are aborted and before state moves. */
  onBeforeChange(handler: TransitionHandler): () => void {
    this.#beforeChange.add(handler);
    return () => this.#beforeChange.delete(handler);
  }

  subscribe(listener: ScopeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Registers a request so a scope change aborts it. `external` is the caller's own signal. */
  track(target: ScopeTarget, external?: AbortSignal): TrackedRequest {
    const controller = new AbortController();
    const entry: Entry = { target, controller, scopeAborted: false };
    this.#inflight.add(entry);
    const onExternalAbort = () => controller.abort(external?.reason);
    if (external) {
      if (external.aborted) onExternalAbort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }
    return {
      signal: controller.signal,
      get scopeAborted() {
        return entry.scopeAborted;
      },
      release: () => {
        this.#inflight.delete(entry);
        external?.removeEventListener("abort", onExternalAbort);
      },
    };
  }

  #abortInvalidated(transition: ScopeTransition): void {
    for (const entry of [...this.#inflight]) {
      const invalidated =
        transition.kind === "user" || entry.target.workspaceId !== null;
      if (!invalidated || entry.controller.signal.aborted) continue;
      entry.scopeAborted = true;
      entry.controller.abort(scopeChangedError());
    }
  }

  #move(transition: ScopeTransition): void {
    this.#abortInvalidated(transition);
    for (const handler of [...this.#beforeChange]) {
      try {
        handler(transition);
      } catch (error) {
        logHandlerFailure(error);
      }
    }
    this.#snapshot = { ...transition.next, version: this.#snapshot.version + 1 };
    const snapshot = this.#snapshot;
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot, transition);
      } catch (error) {
        logHandlerFailure(error);
      }
    }
  }
}

/** Minimal Storage surface so tests, web and React Native can all supply one. */
export interface HintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * The last selected Workspace per Clerk user. It is only a hint to send in
 * `X-Workspace-Id`: the API still checks live membership on every request, and
 * a removed selection comes back as 409 `workspace_selection_changed`.
 */
export interface WorkspaceHintStore {
  keyFor(userId: string): string;
  read(userId: string): string | null;
  write(userId: string, workspaceId: string | null): void;
}

export function createWorkspaceHintStore(storage: HintStorage | null): WorkspaceHintStore {
  const keyFor = (userId: string) => `narriflow:workspace:${userId}`;
  return {
    keyFor,
    read(userId) {
      try {
        const value = storage?.getItem(keyFor(userId)) ?? null;
        return isWorkspaceId(value) ? value : null;
      } catch {
        return null;
      }
    },
    write(userId, workspaceId) {
      try {
        if (!storage) return;
        if (workspaceId === null) storage.removeItem(keyFor(userId));
        else storage.setItem(keyFor(userId), workspaceId);
      } catch {
        // Storage can be full or blocked; the hint is advisory.
      }
    },
  };
}
