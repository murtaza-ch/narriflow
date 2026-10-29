import { expect, test } from "bun:test";
import { MediaWorkScheduler } from "./media-work-scheduler";

function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

test("one render owns CPU, then waiting background work progresses between render groups", async () => {
  const scheduler = new MediaWorkScheduler();
  const signal = new AbortController().signal;
  const encoding = gate();
  const started = gate();
  const actions: string[] = [];
  const first = scheduler.run("render", "first", signal, async () => { actions.push("encode1"); started.release(); await encoding.promise; });
  await started.promise;
  const background = ["preview", "layout", "thumbnail"].map((name) => scheduler.run("background", name, signal, async () => { actions.push(name); }));
  const renders = [2, 3, 4].map((id) => scheduler.run("render", String(id), signal, async () => { actions.push(`encode${id}`); }));
  expect(actions).toEqual(["encode1"]);
  expect(scheduler.snapshot().waiting).toHaveLength(6);
  encoding.release();
  await Promise.all([first, ...background, ...renders]);
  expect(actions).toEqual(["encode1", "preview", "encode2", "layout", "encode3", "thumbnail", "encode4"]);
});

test("queued shutdown work never starts and failure releases the CPU lane", async () => {
  const scheduler = new MediaWorkScheduler();
  const signal = new AbortController().signal;
  const hold = gate();
  const first = scheduler.run("render", "first", signal, () => hold.promise);
  await Promise.resolve();
  const shutdown = new AbortController();
  let starts = 0;
  const queued = scheduler.run("background", "cancelled", shutdown.signal, async () => { starts += 1; });
  shutdown.abort(new Error("shutdown"));
  await expect(queued).rejects.toThrow("shutdown");
  hold.release();
  await first;
  await expect(scheduler.run("render", "failed", signal, async () => { throw new Error("encode failed"); })).rejects.toThrow("encode failed");
  await scheduler.run("background", "next", signal, async () => { starts += 1; });
  expect(starts).toBe(1);
});
