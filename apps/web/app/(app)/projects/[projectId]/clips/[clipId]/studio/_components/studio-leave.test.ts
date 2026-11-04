import { expect, test } from "bun:test";
import type { StudioEditingSession } from "./studio-editing-session";
import { checkpointBeforeLeaving } from "./studio-leave";

function sessionWith(perform: () => Promise<unknown>) {
  return { perform } as unknown as Pick<StudioEditingSession, "perform">;
}

test("leaving waits for the cloud checkpoint", async () => {
  let release!: () => void;
  const performed: unknown[] = [];
  const session = {
    perform: (operation: unknown) => {
      performed.push(operation);
      return new Promise((resolve) => {
        release = () => resolve({ kind: "cloud-current", revision: 4 });
      });
    },
  } as unknown as Pick<StudioEditingSession, "perform">;
  let left = false;
  const leaving = checkpointBeforeLeaving(session, 1_000).then(() => {
    left = true;
  });
  await Promise.resolve();
  expect(left).toBe(false);
  expect(performed).toEqual([{ type: "checkpoint-cloud" }]);
  release();
  await leaving;
  expect(left).toBe(true);
});

test("leaving does not wait past the timeout for a stuck save", async () => {
  const started = Date.now();
  await checkpointBeforeLeaving(sessionWith(() => new Promise(() => undefined)), 20);
  expect(Date.now() - started).toBeLessThan(500);
});

test("leaving proceeds when the checkpoint is blocked", async () => {
  await checkpointBeforeLeaving(
    sessionWith(async () => ({ kind: "cloud-blocked", reason: "semantic-rejection" })),
    1_000,
  );
});

test("leaving offline does not wait for a save that cannot run", async () => {
  const performed: unknown[] = [];
  const session = sessionWith(async () => {
    performed.push("checkpoint");
    return new Promise(() => undefined);
  });
  await checkpointBeforeLeaving(session, 1_000, () => false);
  expect(performed).toEqual([]);
});
