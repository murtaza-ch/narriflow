import { describe, expect, test } from "bun:test";
import { createFakeBackend, collectFrames, ev } from "./test-support";
import { type ProgressStreamOptions, openProgressStream } from "./stream";

function open(
  backend: ReturnType<typeof createFakeBackend>,
  overrides: Partial<ProgressStreamOptions> = {},
) {
  const controller = new AbortController();
  let closed = 0;
  const stream = openProgressStream({
    projectId: "p1",
    sinceSeq: 0,
    signal: controller.signal,
    getEventsSince: backend.getEventsSince,
    subscribeLive: backend.subscribeLive,
    authorize: async () => ({ ok: true }),
    unexpectedControl: () => ({ error: "internal_error" }),
    heartbeatMs: 10_000,
    fallbackPollMs: 10_000,
    maxBufferedEvents: 1_000,
    maxQueuedFrames: 256,
    onClose: () => {
      closed += 1;
    },
    ...overrides,
  });
  const reader = collectFrames(stream.body);
  return { stream, reader, controller, closedCount: () => closed };
}

describe("progress stream", () => {
  test("replays the log after the cursor, then delivers live events once and in order", async () => {
    const backend = createFakeBackend([ev(1), ev(2), ev(3)]);
    const { reader, stream } = open(backend, { sinceSeq: 1 });
    await reader.until((f) => f.some((x) => x.event === "workflow.stage.updated") && backend.liveCount === 1);
    expect(reader.frames[0]).toMatchObject({ event: "connected", data: { projectId: "p1", sinceSeq: 1 } });
    backend.emit(ev(4));
    backend.emit(ev(4)); // a duplicate publish is dropped
    backend.emit(ev(5));
    await reader.until(() => reader.seqs().length === 4);
    expect(reader.seqs()).toEqual([2, 3, 4, 5]);
    stream.close();
  });

  test("an event persisted between replay and subscribe is delivered by the post-subscribe catch-up", async () => {
    const backend = createFakeBackend([ev(1)]);
    const slow = backend.subscribeLive;
    backend.subscribeLive = async (project, handlers) => {
      const subscription = await slow(project, handlers);
      backend.emit(ev(2), { publish: false }); // persisted, but published before anyone listened
      return subscription;
    };
    const { reader, stream } = open(backend);
    await reader.until(() => reader.seqs().length === 2);
    expect(reader.seqs()).toEqual([1, 2]);
    stream.close();
  });

  test("a live event ahead of the cursor recovers the gap from the log first", async () => {
    const backend = createFakeBackend([ev(1)]);
    const { reader, stream } = open(backend);
    await reader.until(() => backend.liveCount === 1 && reader.seqs().length === 1);
    backend.emit(ev(2), { publish: false });
    backend.emit(ev(3)); // published; 2 was lost on the live channel
    await reader.until(() => reader.seqs().length === 3);
    expect(reader.seqs()).toEqual([1, 2, 3]);
    stream.close();
  });

  test("falls back to polling the log when the live channel is unavailable", async () => {
    const backend = createFakeBackend([ev(1)]);
    backend.state.subscribeFails = true;
    const { reader, stream } = open(backend, { fallbackPollMs: 20 });
    await reader.until(() => reader.seqs().length === 1);
    backend.emit(ev(2));
    await reader.until(() => reader.seqs().length === 2);
    stream.close();
  });

  test("a live channel that drops mid-stream hands over to polling without losing or repeating events", async () => {
    const backend = createFakeBackend([ev(1)]);
    const { reader, stream } = open(backend, { fallbackPollMs: 20 });
    await reader.until(() => backend.liveCount === 1 && reader.seqs().length === 1);
    backend.dropLive();
    backend.emit(ev(2));
    backend.emit(ev(3));
    await reader.until(() => reader.seqs().length === 3);
    expect(reader.seqs()).toEqual([1, 2, 3]);
    stream.close();
  });

  test("live events beyond the catch-up buffer bound switch to polling instead of growing", async () => {
    const backend = createFakeBackend([ev(1)]);
    const slow = backend.getEventsSince;
    let calls = 0;
    backend.getEventsSince = async (project, since) => {
      calls += 1;
      if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 60)); // the catch-up read
      return slow(project, since);
    };
    const { reader, stream } = open(backend, { maxBufferedEvents: 3, fallbackPollMs: 20 });
    await reader.until(() => backend.liveCount === 1);
    for (const seq of [2, 3, 4, 5, 6]) backend.emit(ev(seq));
    await reader.until(() => reader.seqs().length === 6);
    expect(reader.seqs()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(backend.liveCount).toBe(0);
    stream.close();
  });

  test("live events piling up behind a blocked gap read are bounded, then recovered from the log", async () => {
    const backend = createFakeBackend([ev(1)]);
    const underlying = backend.getEventsSince;
    let release: () => void = () => undefined;
    let blockNext = false;
    let finishedReads = 0;
    backend.getEventsSince = async (project, since) => {
      if (blockNext) {
        blockNext = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const events = await underlying(project, since);
      finishedReads += 1;
      return events;
    };
    const { reader, stream } = open(backend, { maxBufferedEvents: 3, fallbackPollMs: 20 });
    // Initial replay and post-subscribe catch-up are both done: the stream is live.
    await reader.until(() => backend.liveCount === 1 && finishedReads === 2);
    blockNext = true;
    backend.emit(ev(2), { publish: false });
    backend.emit(ev(3), { publish: false });
    backend.emit(ev(4)); // seq 4 > cursor + 1: starts a gap read that stays blocked
    for (let seq = 5; seq <= 50; seq += 1) backend.emit(ev(seq));
    // Past the bound the live channel is dropped and the pending deliveries are discarded.
    expect(backend.liveCount).toBe(0);
    release();
    await reader.until(() => reader.seqs().length === 50);
    expect(reader.seqs()).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    stream.close();
    expect(backend.state.closed).toBe(1);
  });

  test("ignores a malformed cursor and never sends a sequence twice across the replay and live paths", async () => {
    const backend = createFakeBackend([ev(1), ev(2)]);
    const { reader, stream } = open(backend);
    await reader.until(() => backend.liveCount === 1);
    backend.emit(ev(2));
    backend.emit(ev(1));
    backend.emit(ev(3));
    await reader.until(() => reader.seqs().length === 3);
    expect(reader.seqs()).toEqual([1, 2, 3]);
    stream.close();
  });

  test("each heartbeat re-authorizes and pings; the first refusal sends one control event and closes everything", async () => {
    const backend = createFakeBackend([ev(1)]);
    let checks = 0;
    const { reader, closedCount } = open(backend, {
      heartbeatMs: 15,
      authorize: async () => {
        checks += 1;
        return checks < 3 ? { ok: true } : { ok: false, error: "workspace_restricted", requestId: "r1" };
      },
    });
    await reader.done;
    const events = reader.frames.map((f) => f.event);
    expect(events.filter((e) => e === "ping")).toHaveLength(2);
    expect(events.filter((e) => e === "authorization.revoked")).toHaveLength(1);
    expect(reader.frames.at(-1)).toEqual({
      event: "authorization.revoked",
      data: { error: "workspace_restricted", requestId: "r1" },
    });
    expect(closedCount()).toBe(1);
    expect(backend.liveCount).toBe(0);
    expect(checks).toBe(3);
  });

  test("an unexpected authorization failure closes with one bounded control event", async () => {
    const backend = createFakeBackend();
    const { reader } = open(backend, {
      heartbeatMs: 10,
      authorize: async () => {
        throw new Error("private database failure");
      },
    });
    await reader.done;
    expect(reader.frames.filter((f) => f.event === "authorization.revoked")).toEqual([
      { event: "authorization.revoked", data: { error: "internal_error" } },
    ]);
    expect(JSON.stringify(reader.frames)).not.toContain("private");
  });

  test("a client disconnect releases the subscription, timers and slot exactly once", async () => {
    const backend = createFakeBackend();
    const { reader, controller, closedCount } = open(backend, { fallbackPollMs: 5, heartbeatMs: 5 });
    await reader.until(() => backend.liveCount === 1);
    controller.abort();
    await reader.done;
    expect(backend.liveCount).toBe(0);
    expect(closedCount()).toBe(1);
    const reads = backend.state.logReads;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(backend.state.logReads).toBe(reads); // no timer survives
  });

  test("a reader that stops reading is dropped once its queue passes the bound", async () => {
    const backend = createFakeBackend();
    const controller = new AbortController();
    let closed = 0;
    const stream = openProgressStream({
      projectId: "p1",
      sinceSeq: 0,
      signal: controller.signal,
      getEventsSince: backend.getEventsSince,
      subscribeLive: backend.subscribeLive,
      authorize: async () => ({ ok: true }),
      unexpectedControl: () => ({ error: "internal_error" }),
      heartbeatMs: 10_000,
      fallbackPollMs: 10_000,
      maxBufferedEvents: 1_000,
      maxQueuedFrames: 5,
      onClose: () => {
        closed += 1;
      },
    });
    // Nobody reads the body.
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let seq = 1; seq <= 20; seq += 1) backend.emit(ev(seq));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(closed).toBe(1);
    expect(backend.liveCount).toBe(0);
    void stream.body.cancel();
  });

  test("a failing log at the start ends the stream so the client reconnects", async () => {
    const backend = createFakeBackend();
    backend.state.failLog = true;
    const { reader, closedCount } = open(backend);
    await reader.done;
    expect(reader.frames.map((f) => f.event)).toEqual(["connected"]);
    expect(closedCount()).toBe(1);
  });

  test("an already aborted request never subscribes", async () => {
    const backend = createFakeBackend([ev(1)]);
    const controller = new AbortController();
    controller.abort();
    const stream = openProgressStream({
      projectId: "p1",
      sinceSeq: 0,
      signal: controller.signal,
      getEventsSince: backend.getEventsSince,
      subscribeLive: backend.subscribeLive,
      authorize: async () => ({ ok: true }),
      unexpectedControl: () => ({ error: "internal_error" }),
      heartbeatMs: 1_000,
      fallbackPollMs: 1_000,
      maxBufferedEvents: 10,
      maxQueuedFrames: 10,
      onClose: () => undefined,
    });
    await collectFrames(stream.body).done;
    expect(backend.state.subscribed).toBe(0);
  });
});
