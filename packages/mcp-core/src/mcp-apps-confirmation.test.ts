import { describe, expect, test } from "bun:test";
import { createPublicationDecision, isPublicationDeclined } from "./mcp-apps/v1/publication-decision";

describe("MCP App publication decision", () => {
  test("an in-flight decision and successful scheduling prevent another decision", async () => {
    const decision = createPublicationDecision();
    let release!: () => void;
    let calls = 0;
    const pending = decision.decide(true, async () => { calls++; await new Promise<void>((resolve) => { release = resolve; }); });
    expect(decision.canConfirm).toBe(false);
    expect(decision.canDecline).toBe(false);
    await decision.decide(false, async () => { calls++; });
    release();
    await pending;
    await decision.decide(true, async () => { calls++; });
    await decision.decide(false, async () => { calls++; });
    expect(calls).toBe(1);
    expect(decision.state).toBe("scheduled");
    expect(decision.canConfirm).toBe(false);
    expect(decision.canDecline).toBe(false);
  });

  test("a declined intent is terminal; an unavailable decision remains retryable", async () => {
    const declined = createPublicationDecision();
    await declined.decide(false, async () => {
      expect(isPublicationDeclined({ isError: true, structuredContent: { data: { error: "mcp_confirmation_declined" } } })).toBe(true);
    });
    expect(declined.state).toBe("declined");
    expect(declined.canDecline).toBe(false);
    expect(declined.canConfirm).toBe(false);
    const unavailable = createPublicationDecision();
    await expect(unavailable.decide(true, async () => { throw new Error("Unavailable"); })).rejects.toThrow("Unavailable");
    expect(unavailable.canConfirm).toBe(true);
    expect(unavailable.canDecline).toBe(true);
    expect(isPublicationDeclined({ isError: true, structuredContent: { data: { error: "mcp_confirmation_expired" } } })).toBe(false);
  });

  test("a lost scheduling response prevents decline and retries the same accepted intent", async () => {
    const decision = createPublicationDecision();
    await expect(decision.decide(true, async (markSchedulingAttempted) => {
      markSchedulingAttempted();
      throw new Error("Lost response");
    })).rejects.toThrow("Lost response");
    expect(decision.state).toBe("uncertain");
    expect(decision.canDecline).toBe(false);
    expect(decision.canConfirm).toBe(true);
    let declined = false;
    await decision.decide(false, async () => { declined = true; });
    expect(declined).toBe(false);
    await decision.decide(true, async () => {});
    expect(decision.state).toBe("scheduled");
    expect(decision.canConfirm).toBe(false);
  });
});
