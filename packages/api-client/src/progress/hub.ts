import type { QueryClient } from "@tanstack/query-core";
import type {
  ProgressRevokedControl,
  WorkflowStageUpdatedEvent,
} from "@narriflow/validators/api/progress";
import {
  type ApiError,
  type ApiTransport,
  type EventStreamOptions,
  type StreamEnd,
  type WorkspaceScope,
  runEventStream,
} from "../core";
import {
  type ProgressMessage,
  decodeProgressMessage,
  isTerminalProgress,
  terminalProgressIdentity,
} from "./events";
import { invalidateAfterProgress, invalidateAfterTerminalProgress } from "./invalidation";

/** Trailing throttle for non-terminal bursts (matches the Project page's long-standing 5 seconds). */
export const PROGRESS_INVALIDATE_THROTTLE_MS = 5_000;
/** How long an unused connection stays open, so a route change that unmounts one consumer and mounts the next reuses it. */
export const PROGRESS_LINGER_MS = 3_000;
const BUFFER_LIMIT = 500;
const TERMINAL_MEMORY = 256;

export interface ProgressSubscriber {
  /**
   * The newest sequence this subscriber already holds. Only later events are
   * delivered, from the connection's buffer first and then live. Default 0:
   * everything the log still has.
   */
  sinceSeq?: number;
  onEvent?(event: WorkflowStageUpdatedEvent): void;
  /** The connection (re)opened; `reconnected` is false for the first open. Anything that expires while disconnected should be re-read. */
  onOpen?(info: { reconnected: boolean }): void;
  /** Access ended (membership removed, restriction, Project gone). The stream is closed and not retried. */
  onRevoked?(control: ProgressRevokedControl): void;
  /** Retrying cannot help: signed out, forbidden, missing, or the Workspace changed. The stream is closed. */
  onFatal?(error: ApiError): void;
}

export interface ProgressHub {
  /**
   * Joins the one connection for this Project in this identity + Workspace,
   * opening it if needed. Returns the unsubscribe function; the connection
   * closes shortly after its last subscriber leaves.
   */
  subscribe(scope: WorkspaceScope, projectId: string, subscriber: ProgressSubscriber): () => void;
}

export interface ProgressHubOptions {
  transport: ApiTransport;
  queryClient: QueryClient;
  /** Test seams. */
  runStream?: typeof runEventStream;
  now?: () => number;
  lingerMs?: number;
  throttleMs?: number;
}

interface Member {
  subscriber: ProgressSubscriber;
  /** The newest sequence delivered to this subscriber. */
  delivered: number;
}

interface Entry {
  scope: WorkspaceScope;
  projectId: string;
  members: Set<Member>;
  /** Recent events, ascending, complete for every sequence after `floor`. */
  buffer: WorkflowStageUpdatedEvent[];
  floor: number;
  abort: AbortController;
  opens: number;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  trailingTimer: ReturnType<typeof setTimeout> | null;
  lastInvalidatedAt: number;
  terminalSeen: Set<string>;
  terminalPending: boolean;
}

function remember(set: Set<string>, value: string): boolean {
  if (set.has(value)) return false;
  set.add(value);
  if (set.size > TERMINAL_MEMORY) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  return true;
}

function safely(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    // One consumer's bug must not stop the others or the stream.
    console.warn(
      JSON.stringify({
        level: "error",
        message: "progress_subscriber_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

/**
 * Owns the progress connections of one app instance. At most one stream per
 * (identity, Workspace, Project) is open however many consumers are mounted;
 * the Project page, the upload import pill and the export delivery page all
 * join it. The hub also owns the cache effects of progress so they happen once:
 * non-terminal events invalidate the Project's reads behind a 5-second trailing
 * throttle, and each terminal outcome invalidates what its run produced once.
 */
export function createProgressHub(options: ProgressHubOptions): ProgressHub {
  const run = options.runStream ?? runEventStream;
  const now = options.now ?? Date.now;
  const lingerMs = options.lingerMs ?? PROGRESS_LINGER_MS;
  const throttleMs = options.throttleMs ?? PROGRESS_INVALIDATE_THROTTLE_MS;
  const entries = new Map<string, Entry>();

  const keyOf = (scope: WorkspaceScope, projectId: string) =>
    JSON.stringify([scope.userId, scope.workspaceId, projectId]);

  function invalidate(entry: Entry, terminal: boolean): void {
    const { queryClient } = options;
    const { scope, projectId } = entry;
    void (terminal
      ? invalidateAfterTerminalProgress(queryClient, scope, projectId)
      : invalidateAfterProgress(queryClient, scope, projectId)
    ).catch(() => undefined);
  }

  function throttledInvalidate(entry: Entry): void {
    const elapsed = now() - entry.lastInvalidatedAt;
    if (elapsed >= throttleMs) {
      entry.lastInvalidatedAt = now();
      invalidate(entry, false);
      return;
    }
    // A trailing invalidation is already scheduled for this burst.
    if (entry.trailingTimer !== null) return;
    entry.trailingTimer = setTimeout(() => {
      entry.trailingTimer = null;
      entry.lastInvalidatedAt = now();
      invalidate(entry, false);
    }, throttleMs - elapsed);
  }

  function terminalInvalidate(entry: Entry): void {
    // A replayed history can hold several terminal events in one chunk: refresh once for the burst.
    if (entry.terminalPending) return;
    entry.terminalPending = true;
    setTimeout(() => {
      entry.terminalPending = false;
      if (entries.get(keyOf(entry.scope, entry.projectId)) === entry) invalidate(entry, true);
    }, 0);
  }

  function deliver(member: Member, event: WorkflowStageUpdatedEvent): void {
    if (event.seq <= member.delivered) return;
    member.delivered = event.seq;
    const { onEvent } = member.subscriber;
    if (onEvent) safely(() => onEvent(event));
  }

  function applyEvent(entry: Entry, event: WorkflowStageUpdatedEvent): void {
    const last = entry.buffer.at(-1);
    if (last && event.seq <= last.seq) return;
    entry.buffer.push(event);
    if (entry.buffer.length > BUFFER_LIMIT) {
      const dropped = entry.buffer.shift();
      if (dropped) entry.floor = Math.max(entry.floor, dropped.seq);
    }
    for (const member of entry.members) deliver(member, event);
    if (isTerminalProgress(event)) {
      if (remember(entry.terminalSeen, terminalProgressIdentity(event))) terminalInvalidate(entry);
    } else {
      throttledInvalidate(entry);
    }
  }

  function close(entry: Entry): void {
    entry.abort.abort();
    if (entry.lingerTimer !== null) clearTimeout(entry.lingerTimer);
    if (entry.trailingTimer !== null) clearTimeout(entry.trailingTimer);
    entry.lingerTimer = null;
    entry.trailingTimer = null;
  }

  function drop(key: string, entry: Entry): void {
    close(entry);
    if (entries.get(key) === entry) entries.delete(key);
  }

  function start(key: string, entry: Entry, from: number): void {
    const abort = new AbortController();
    entry.abort = abort;
    entry.floor = from;
    entry.buffer = [];
    const stream: EventStreamOptions<ProgressMessage> = {
      transport: options.transport.scoped(entry.scope),
      path: `/api/stream/${encodeURIComponent(entry.projectId)}`,
      signal: abort.signal,
      initialCursor: from,
      query: (cursor) => ({ sinceSeq: cursor ?? from }),
      decode: decodeProgressMessage,
      cursorOf: (message) => (message.kind === "event" ? message.event.seq : null),
      onStatus: (status) => {
        if (status.state !== "open" || abort.signal.aborted) return;
        const reconnected = entry.opens > 0;
        entry.opens += 1;
        for (const member of [...entry.members]) {
          const { onOpen } = member.subscriber;
          if (onOpen) safely(() => onOpen({ reconnected }));
        }
      },
      onEvent: (message) => {
        if (abort.signal.aborted) return;
        if (message.kind === "event") {
          applyEvent(entry, message.event);
          return;
        }
        // An expired session token closes the stream and the run reconnects with
        // a fresh one; any other revocation ends access to this Project.
        if (message.control.error === "authentication_required") return;
        const members = [...entry.members];
        drop(key, entry);
        for (const member of members) {
          const { onRevoked } = member.subscriber;
          if (onRevoked) safely(() => onRevoked(message.control));
        }
      },
    };
    void run(stream).then((end: StreamEnd) => {
      if (end.reason !== "fatal" || abort.signal.aborted) return;
      const members = [...entry.members];
      drop(key, entry);
      for (const member of members) {
        const { onFatal } = member.subscriber;
        if (onFatal) safely(() => onFatal(end.error));
      }
    });
  }

  return {
    subscribe(scope, projectId, subscriber) {
      const key = keyOf(scope, projectId);
      const sinceSeq = Math.max(0, subscriber.sinceSeq ?? 0);
      const member: Member = { subscriber, delivered: sinceSeq };
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          scope,
          projectId,
          members: new Set(),
          buffer: [],
          floor: sinceSeq,
          abort: new AbortController(),
          opens: 0,
          lingerTimer: null,
          trailingTimer: null,
          lastInvalidatedAt: 0,
          terminalSeen: new Set(),
          terminalPending: false,
        };
        entries.set(key, entry);
        entry.members.add(member);
        start(key, entry, sinceSeq);
        return unsubscribeOf(key, entry, member);
      }
      if (entry.lingerTimer !== null) {
        clearTimeout(entry.lingerTimer);
        entry.lingerTimer = null;
      }
      entry.members.add(member);
      if (sinceSeq < entry.floor) {
        // The buffer no longer reaches back far enough for this subscriber: reconnect from its cursor.
        // Subscribers that already hold the newer events skip them by their own cursor.
        entry.abort.abort();
        start(key, entry, sinceSeq);
      } else {
        for (const event of entry.buffer) deliver(member, event);
      }
      return unsubscribeOf(key, entry, member);
    },
  };

  function unsubscribeOf(key: string, entry: Entry, member: Member): () => void {
    return () => {
      if (!entry.members.delete(member) || entry.members.size > 0) return;
      entry.lingerTimer = setTimeout(() => {
        entry.lingerTimer = null;
        if (entry.members.size === 0) drop(key, entry);
      }, lingerMs);
    };
  }
}
