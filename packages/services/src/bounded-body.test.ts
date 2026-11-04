import { describe, expect, test } from "bun:test";
import { readBoundedBody } from "./bounded-body";

const stream = (...chunks: number[]) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) return controller.close();
      controller.enqueue(new Uint8Array(next).fill(7));
    },
    cancel() { cancelled = true; },
  });
  return { body, cancelled: () => cancelled };
};

describe("readBoundedBody", () => {
  test("returns every byte in order, and an empty array for no body", async () => {
    const { body } = stream(3, 2);
    const result = await readBoundedBody(body, 5);
    expect(result.kind === "ok" && result.bytes.byteLength).toBe(5);
    expect(await readBoundedBody(null, 5)).toEqual({ kind: "ok", bytes: new Uint8Array() });
  });

  test("stops and cancels the stream as soon as it passes the limit", async () => {
    const { body, cancelled } = stream(4, 4, 4);
    expect(await readBoundedBody(body, 7)).toEqual({ kind: "too_large" });
    expect(cancelled()).toBe(true);
  });

  test("an upstream whose cancel never settles, or rejects, cannot hold the answer", async () => {
    for (const cancel of [() => new Promise<void>(() => {}), () => Promise.reject(new Error("reset"))]) {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(4)); sent += 1; }, cancel });
      const result = await Promise.race([readBoundedBody(body, 7), new Promise((resolve) => setTimeout(() => resolve("hung"), 500))]);
      expect(result).toEqual({ kind: "too_large" });
      expect(sent).toBeGreaterThan(0);
    }
  });
});
