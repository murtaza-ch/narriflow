import type { ProgressStreamOptions, SequencedEvent, SubscribeLive } from "./stream";

export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/** Reads an SSE body to its end (or until `stop`), returning frames as they arrive. */
export function collectFrames(body: ReadableStream<Uint8Array>) {
  const frames: SseFrame[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  const reader = body.getReader();
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          for (const wake of waiters.splice(0)) wake();
        }
      }
    } catch {
      // A cancelled body ends the read.
    } finally {
      ended = true;
      for (const wake of waiters.splice(0)) wake();
    }
  })();
  return {
    frames,
    done,
    /** Stops reading, like a client that disconnects. */
    cancel: () => reader.cancel(),
    get ended() {
      return ended;
    },
    /** Resolves when `predicate(frames)` holds, or rejects after `timeoutMs`. */
    async until(predicate: (frames: SseFrame[]) => boolean, timeoutMs = 2_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(frames)) {
        if (ended && !predicate(frames)) throw new Error(`stream ended; frames: ${JSON.stringify(frames)}`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out; frames: ${JSON.stringify(frames)}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, Math.min(left, 25));
        });
      }
    },
    seqs: () => frames.filter((f) => f.event === "workflow.stage.updated").map((f) => f.data.seq as number),
  };
}

export const ev = (seq: number): SequencedEvent & { stage: string } => ({ seq, stage: "clip_rendering" });

/** An in-memory durable log with a live fan-out, shaped like the production deps. */
export function createFakeBackend(initial: SequencedEvent[] = []) {
  const log = [...initial];
  const listeners = new Set<{ onEvent(e: SequencedEvent): void; onEnd(): void }>();
  const state = { logReads: 0, failLog: false, subscribeFails: false, subscribed: 0, closed: 0 };
  const getEventsSince: ProgressStreamOptions["getEventsSince"] = async (_project, since) => {
    state.logReads += 1;
    if (state.failLog) throw new Error("db down");
    return log.filter((e) => e.seq > since);
  };
  const subscribeLive: SubscribeLive = async (_project, handlers) => {
    if (state.subscribeFails) throw new Error("redis down");
    state.subscribed += 1;
    listeners.add(handlers);
    return {
      close() {
        if (listeners.delete(handlers)) state.closed += 1;
      },
    };
  };
  return {
    state,
    log,
    getEventsSince,
    subscribeLive,
    /** Persist then publish, like the worker. */
    emit(event: SequencedEvent, options: { publish?: boolean } = {}) {
      log.push(event);
      if (options.publish !== false) for (const l of [...listeners]) l.onEvent(event);
    },
    dropLive() {
      for (const l of [...listeners]) {
        listeners.delete(l);
        l.onEnd();
      }
    },
    get liveCount() {
      return listeners.size;
    },
  };
}
