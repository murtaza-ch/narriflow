import { describe, expect, test } from "bun:test";
import {
  BrowserStudioCoordinationAdapter,
  parseStudioCoordinationEvent,
} from "./studio-editing-session-browser";

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
    let rejectHeldRequest: ((error: Error) => void) | null = null;
    let ownershipLosses = 0;
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
    try {
      const adapter = new BrowserStudioCoordinationAdapter("project", "clip");
      const surface = adapter as unknown as {
        participant: {
          onTakeoverRequested(): Promise<"checkpointed">;
          onOwnershipLost(): void;
        };
        acquireBrowserLock(options: LockOptions): Promise<number | null>;
      };
      surface.participant = {
        onTakeoverRequested: async () => "checkpointed",
        onOwnershipLost: () => { ownershipLosses += 1; },
      };

      expect(await surface.acquireBrowserLock({})).toBeGreaterThan(0);
      if (!rejectHeldRequest) throw new Error("expected a held Web Lock request");
      rejectHeldRequest(new Error("Lock was stolen"));
      await Promise.resolve();
      await Promise.resolve();
      expect(ownershipLosses).toBe(1);
    } finally {
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "navigator");
      }
    }
  });
});
