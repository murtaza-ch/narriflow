import { describe, expect, test } from "bun:test";
import {
  classifyStudioCloudResponse,
  createBrowserStudioSessionDependencies,
  parseStudioCoordinationEvent,
} from "./studio-editing-session-browser";

test("classifies retryable and terminal editor responses without conflating them", () => {
  expect(classifyStudioCloudResponse(408, null)).toEqual({
    kind: "transient",
    reason: "timeout",
  });
  expect(classifyStudioCloudResponse(425, null)).toEqual({
    kind: "transient",
    reason: "too-early",
  });
  expect(classifyStudioCloudResponse(429, null)).toEqual({
    kind: "transient",
    reason: "rate-limited",
  });
  expect(classifyStudioCloudResponse(503, null)).toEqual({
    kind: "transient",
    reason: "server",
  });
  expect(classifyStudioCloudResponse(401, null)).toEqual({
    kind: "authentication-lost",
  });
  expect(classifyStudioCloudResponse(404, null)).toEqual({ kind: "missing" });
  expect(
    classifyStudioCloudResponse(422, { error: "editor_document_empty_timeline" }),
  ).toEqual({
    kind: "rejected",
    code: "editor_document_empty_timeline",
  });
  expect(
    classifyStudioCloudResponse(409, { details: { currentRevision: 9 } }),
  ).toEqual({ kind: "revision-conflict", currentRevision: 9 });
});

describe("browser Studio coordination adapter", () => {
  test("normalizes only complete clip-scoped coordination events", () => {
    expect(
      parseStudioCoordinationEvent({
        type: "takeover-request",
        ownerId: "incoming",
        requestId: "request-1",
      }),
    ).toEqual({
      type: "takeover-request",
      ownerId: "incoming",
      requestId: "request-1",
    });
    expect(
      parseStudioCoordinationEvent({
        type: "handoff-ready",
        ownerId: "outgoing",
        targetId: "incoming",
        requestId: "request-1",
      }),
    ).toEqual({
      type: "handoff-ready",
      ownerId: "outgoing",
      targetId: "incoming",
      requestId: "request-1",
    });
    expect(parseStudioCoordinationEvent({ type: "takeover-request" })).toBeNull();
    expect(parseStudioCoordinationEvent({ type: "unknown", ownerId: "tab" })).toBeNull();
    expect(parseStudioCoordinationEvent("takeover-request")).toBeNull();
  });

  test("reports ownership loss when a held Web Lock is forcibly stolen", async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const localStorageDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const broadcastDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "BroadcastChannel",
    );
    let rejectHeldRequest: ((error: Error) => void) | null = null;
    let ownershipLosses = 0;
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request: async (
            _name: string,
            _options: LockOptions,
            callback: (lock: Lock | null) => Promise<void>,
          ) => {
            void callback({ name: "clip", mode: "exclusive" } as Lock);
            return new Promise<void>((_resolve, reject) => {
              rejectHeldRequest = reject;
            });
          },
        },
      },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        setInterval: () => 1,
        clearInterval: () => undefined,
        setTimeout,
        clearTimeout,
      },
    });
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: undefined,
    });
    try {
      const coordination = createBrowserStudioSessionDependencies({
        projectId: "project",
        clipId: "clip",
      }).coordination;
      expect(await coordination.start({
        onTakeoverRequested: async () => "checkpointed",
        onOwnershipLost: () => { ownershipLosses += 1; },
      })).toMatchObject({ kind: "writer" });
      if (!rejectHeldRequest) throw new Error("expected a held Web Lock request");
      rejectHeldRequest(new Error("Lock was stolen"));
      await Promise.resolve();
      await Promise.resolve();
      expect(ownershipLosses).toBe(1);
      coordination.close();
    } finally {
      for (const [name, descriptor] of [
        ["navigator", navigatorDescriptor],
        ["localStorage", localStorageDescriptor],
        ["window", windowDescriptor],
        ["BroadcastChannel", broadcastDescriptor],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});
