import { expect, test } from "bun:test";
import type {
  StudioEditingSession,
  StudioSessionOperation,
  StudioSessionSnapshot,
} from "./studio-editing-session";
import { createBrowserStudioSessionLifecycle } from "./studio-editing-session-lifecycle-browser";

function makeHarness() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const timers = new Map<number, () => void>();
  const operations: StudioSessionOperation[] = [];
  let nextTimer = 1;
  const snapshot = {
    durability: { device: "pending", protectsNavigation: true },
  } as StudioSessionSnapshot;
  const session = {
    getSnapshot: () => snapshot,
    perform: async (operation) => {
      operations.push(operation);
      return { kind: "unavailable", reason: "invalid-state" };
    },
  } as Pick<StudioEditingSession, "getSnapshot" | "perform">;
  const browser = {
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    setTimeout: (callback: () => void) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  };
  const emit = (type: string, event: Event) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return { browser, emit, operations, session, timers };
}

test("translates page lifecycle into public Studio session operations", async () => {
  const harness = makeHarness();
  const lifecycle = createBrowserStudioSessionLifecycle(
    harness.session,
    harness.browser,
  );

  lifecycle.mount();
  harness.emit("pagehide", { persisted: false } as PageTransitionEvent);
  harness.emit("pageshow", { persisted: true } as PageTransitionEvent);
  lifecycle.unmount();
  for (const callback of harness.timers.values()) callback();
  await Promise.resolve();

  expect(harness.operations).toEqual([
    { type: "start" },
    { type: "close", reason: "pagehide" },
    { type: "resume" },
    { type: "close", reason: "unmount" },
  ]);
});

test("warns only while the session reports an unprotected Device Draft", () => {
  const harness = makeHarness();
  const lifecycle = createBrowserStudioSessionLifecycle(
    harness.session,
    harness.browser,
  );
  let prevented = 0;
  const event = {
    preventDefault: () => {
      prevented += 1;
    },
    returnValue: undefined,
  } as unknown as BeforeUnloadEvent;

  lifecycle.mount();
  harness.emit("beforeunload", event);
  expect(prevented).toBe(1);
  expect(event.returnValue).toBe("");

  lifecycle.suppressNavigationWarning();
  harness.emit("beforeunload", event);
  expect(prevented).toBe(1);
});

test("cancels a deferred Strict Mode close when the adapter remounts", () => {
  const harness = makeHarness();
  const lifecycle = createBrowserStudioSessionLifecycle(
    harness.session,
    harness.browser,
  );

  lifecycle.mount();
  lifecycle.unmount();
  expect(harness.timers.size).toBe(1);

  lifecycle.mount();
  expect(harness.timers.size).toBe(0);
  expect(harness.operations).toEqual([{ type: "start" }, { type: "start" }]);
});
