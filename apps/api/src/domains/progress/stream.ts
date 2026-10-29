import {
  PROGRESS_STREAM_EVENTS,
  advanceWorkflowCursor,
  isAfterWorkflowCursor,
} from "@narriflow/validators/api/progress";
import {
  type ReauthorizationControl,
  type ReauthorizationResult,
  createReauthorizationGuard,
} from "./reauthorization";

/** Anything the stream forwards: a persisted or live workflow event, ordered by `seq`. */
export interface SequencedEvent {
  seq: number;
}

export interface LiveSubscription {
  close(): void;
}

/**
 * Subscribes to a Project's live events. Resolves once subscribed (events may
 * already be flowing); rejects when no live channel is available. `onEnd`
 * reports a connection lost later. Closing must stop both callbacks.
 */
export type SubscribeLive = (
  projectId: string,
  handlers: { onEvent(event: SequencedEvent): void; onEnd(): void },
) => Promise<LiveSubscription>;

export interface ProgressStreamOptions {
  projectId: string;
  /** Resume cursor: only events with a greater `seq` are sent. */
  sinceSeq: number;
  /** The request's abort signal; a client disconnect ends the stream. */
  signal: AbortSignal;
  /** The durable event log. */
  getEventsSince(projectId: string, sinceSeq: number): Promise<readonly SequencedEvent[]>;
  /** Live delivery, or null to serve from the durable log alone. */
  subscribeLive: SubscribeLive | null;
  /** A fresh access check (new token verification, membership, status and Project). */
  authorize(): Promise<ReauthorizationResult>;
  unexpectedControl(error: unknown): ReauthorizationControl;
  heartbeatMs: number;
  /** Poll interval while there is no live channel. */
  fallbackPollMs: number;
  /** Live events held while the replay catches up; past this the stream falls back to polling. */
  maxBufferedEvents: number;
  /** Frames a slow client may leave unread before the connection is dropped (it reconnects from its cursor). */
  maxQueuedFrames: number;
  /** Called exactly once when the stream ends for any reason. */
  onClose(): void;
}

export interface ProgressStream {
  body: ReadableStream<Uint8Array>;
  /** Idempotent. Used by the drain closer. */
  close(): void;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * One progress connection: DB replay from `sinceSeq`, then live events from
 * the subscription with a post-subscribe catch-up (closing the replay/subscribe
 * race), sequence-gap recovery from the log, and polling of the log when the
 * live channel is absent or lost. A heartbeat re-authorizes on every beat and
 * sends at most one control event before closing when access ended.
 */
export function openProgressStream(options: ProgressStreamOptions): ProgressStream {
  const { projectId } = options;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let active = true;
  let finished = false;
  let cursor = options.sinceSeq;
  let live: LiveSubscription | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  const guard = createReauthorizationGuard({
    authorize: options.authorize,
    onAuthorized: () => {
      send(PROGRESS_STREAM_EVENTS.ping, { ts: Date.now() });
    },
    onRevoked: (control) => {
      send(PROGRESS_STREAM_EVENTS.revoked, control);
    },
    cleanup: () => cleanup(),
    close: () => closeController(),
    unexpectedControl: options.unexpectedControl,
  });

  function cleanup(): void {
    active = false;
    guard.stop();
    if (heartbeat !== null) clearInterval(heartbeat);
    if (poller !== null) clearInterval(poller);
    heartbeat = null;
    poller = null;
    disconnectLive();
    options.signal.removeEventListener("abort", onAbort);
    if (!finished) {
      finished = true;
      options.onClose();
    }
  }

  function closeController(): void {
    try {
      controller?.close();
    } catch {
      // The consumer may have closed the stream at the same time.
    }
  }

  function shutdown(): void {
    cleanup();
    closeController();
  }

  function onAbort(): void {
    shutdown();
  }

  function disconnectLive(): void {
    const current = live;
    live = null;
    current?.close();
  }

  function send(event: string, data: unknown): boolean {
    if (!active || controller === null) return false;
    try {
      // desiredSize counts down from 1 as unread frames queue up.
      if ((controller.desiredSize ?? 1) < 1 - options.maxQueuedFrames) {
        shutdown();
        return false;
      }
      controller.enqueue(encoder.encode(frame(event, data)));
      return true;
    } catch {
      shutdown();
      return false;
    }
  }

  function sendPersisted(events: readonly SequencedEvent[]): boolean {
    for (const event of events) {
      if (!isAfterWorkflowCursor(cursor, event.seq)) continue;
      if (!send(PROGRESS_STREAM_EVENTS.workflow, event)) return false;
      cursor = advanceWorkflowCursor(cursor, event.seq);
    }
    return true;
  }

  async function pollPersisted(): Promise<void> {
    if (!active || pollInFlight) return;
    pollInFlight = true;
    let events: readonly SequencedEvent[];
    try {
      events = await options.getEventsSince(projectId, cursor);
    } catch {
      // The next bounded interval retries; database details are never exposed.
      return;
    } finally {
      pollInFlight = false;
    }
    if (active) sendPersisted(events);
  }

  function startFallbackPolling(): void {
    if (!active || poller !== null) return;
    void pollPersisted();
    poller = setInterval(() => void pollPersisted(), options.fallbackPollMs);
  }

  function fallbackToPolling(): void {
    disconnectLive();
    startFallbackPolling();
  }

  async function deliverLive(event: SequencedEvent): Promise<void> {
    if (!active || !isAfterWorkflowCursor(cursor, event.seq)) return;
    if (event.seq > cursor + 1) {
      // A gap: recover the missing events from the log before this one.
      let missing: readonly SequencedEvent[];
      try {
        missing = await options.getEventsSince(projectId, cursor);
      } catch {
        fallbackToPolling();
        return;
      }
      if (!active) return;
      if (!sendPersisted(missing)) return;
      if (!isAfterWorkflowCursor(cursor, event.seq)) return;
      if (event.seq !== cursor + 1) {
        fallbackToPolling();
        return;
      }
    }
    if (send(PROGRESS_STREAM_EVENTS.workflow, event)) {
      cursor = advanceWorkflowCursor(cursor, event.seq);
    }
  }

  async function connectLive(subscribeLive: SubscribeLive): Promise<void> {
    let catchingUp = true;
    const buffered: SequencedEvent[] = [];
    let chain: Promise<void> = Promise.resolve();
    const queueLive = (event: SequencedEvent) => {
      chain = chain.then(() => deliverLive(event)).catch(() => {
        if (active) fallbackToPolling();
      });
    };
    const subscription = await subscribeLive(projectId, {
      onEvent: (event) => {
        if (!active) return;
        if (catchingUp) {
          if (buffered.length >= options.maxBufferedEvents) {
            fallbackToPolling();
            return;
          }
          buffered.push(event);
          return;
        }
        queueLive(event);
      },
      onEnd: () => {
        live = null;
        startFallbackPolling();
      },
    });
    if (!active) {
      subscription.close();
      return;
    }
    live = subscription;

    // Close the replay/subscribe race, then drain what arrived meanwhile in order.
    const catchUp = await options.getEventsSince(projectId, cursor);
    if (!active) return;
    if (!sendPersisted(catchUp)) return;
    catchingUp = false;
    buffered.sort((left, right) => left.seq - right.seq);
    for (const event of buffered) {
      await deliverLive(event);
      if (!active) return;
    }
    buffered.length = 0;
  }

  async function run(): Promise<void> {
    send(PROGRESS_STREAM_EVENTS.connected, {
      projectId,
      sinceSeq: options.sinceSeq,
      ts: new Date().toISOString(),
    });
    heartbeat = setInterval(() => void guard.check(), options.heartbeatMs);

    let cached: readonly SequencedEvent[];
    try {
      cached = await options.getEventsSince(projectId, cursor);
    } catch {
      // Without the durable log there is nothing to serve; the client reconnects with backoff.
      shutdown();
      return;
    }
    if (!active || !sendPersisted(cached)) return;

    if (options.subscribeLive) {
      try {
        await connectLive(options.subscribeLive);
      } catch {
        // Live delivery is unavailable: continue from the durable log.
        if (active) fallbackToPolling();
      }
    } else {
      startFallbackPolling();
    }
  }

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        shutdown();
        return;
      }
      run().catch(() => shutdown());
    },
    cancel() {
      cleanup();
    },
  });

  return { body, close: shutdown };
}
