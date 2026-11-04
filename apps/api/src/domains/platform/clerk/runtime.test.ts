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
  mailerConfig: (environment: Record<string, string | undefined>) => ({ apiKey: environment.RESEND_API_KEY }),
  relayClerkEmail: async (payload: unknown, options: unknown) => {
    relayCalls.push({ payload, options });
    return { sent: true };
  },
}));

const { withServiceEnvironment } = await import("@narriflow/services/runtime-environment");
const { createClerkWebhookDependencies } = await import("./runtime");
const deps = createClerkWebhookDependencies({ webhookSecret: "whsec", clerkClient: {} as never });

describe("Clerk webhook runtime wiring", () => {
  test("the Resend idempotency key is purpose-bound and stable per Svix message", async () => {
    await withServiceEnvironment({ RESEND_API_KEY: "re_worker" }, async () => {
      await deps.relayEmail({ subject: "Code" }, "msg_abc");
      await deps.relayEmail({ subject: "Code" }, "msg_abc");
    });
    // The provider key comes from the Worker's settings, never process.env.
    expect(relayCalls.map((call) => call.options)).toEqual([
      { apiKey: "re_worker", idempotencyKey: "clerk-email/msg_abc" },
      { apiKey: "re_worker", idempotencyKey: "clerk-email/msg_abc" },
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
