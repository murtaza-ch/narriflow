import { describe, expect, test } from "bun:test";
import { parseStudioCoordinationEvent } from "./studio-editing-session-browser";

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
});
