import { describe, expect, mock, test } from "bun:test";

class ClerkIdentityDeletedError extends Error {
  constructor(readonly clerkId: string) {
    super("deleted");
  }
}
let syncOutcome: unknown;
const relayCalls: Array<{ payload: unknown; options: unknown }> = [];

mock.module("@narriflow/auth", () => ({
  claimWebhookDelivery: async () => "claimed",
  ClerkIdentityDeletedError,
  markUserDeletedByClerkId: async () => undefined,
  recordWebhookDeliveryLog: async () => undefined,
  syncClerkUserPayload: async () => {
    if (syncOutcome) throw syncOutcome;
  },
  verifyClerkWebhook: () => ({ type: "x", data: {} }),
}));
mock.module("@narriflow/email", () => ({
  relayClerkEmail: async (payload: unknown, options: unknown) => {
    relayCalls.push({ payload, options });
    return { sent: true };
  },
}));

const { createClerkWebhookDependencies } = await import("./runtime");
const deps = createClerkWebhookDependencies({ webhookSecret: "whsec", clerkClient: {} as never });

describe("Clerk webhook runtime wiring", () => {
  test("the Resend idempotency key is purpose-bound and stable per Svix message", async () => {
    await deps.relayEmail({ subject: "Code" }, "msg_abc");
    await deps.relayEmail({ subject: "Code" }, "msg_abc");
    expect(relayCalls.map((call) => call.options)).toEqual([
      { idempotencyKey: "clerk-email/msg_abc" },
      { idempotencyKey: "clerk-email/msg_abc" },
    ]);
  });

  test("a stale create/update for a deleted identity is acknowledged; other failures still fail", async () => {
    const warn = mock(() => undefined);
    const original = console.warn;
    console.warn = warn;
    try {
      syncOutcome = new ClerkIdentityDeletedError("user_gone");
      await expect(deps.syncUser({ id: "user_gone" })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      syncOutcome = new Error("db down");
      await expect(deps.syncUser({ id: "user_1" })).rejects.toThrow("db down");
    } finally {
      console.warn = original;
      syncOutcome = null;
    }
  });
});
