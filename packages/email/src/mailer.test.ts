import { beforeEach, describe, expect, mock, test } from "bun:test";

const sends: Array<{ payload: unknown; options: unknown }> = [];
mock.module("resend", () => ({
  Resend: class {
    emails = {
      send: async (payload: unknown, options: unknown) => {
        sends.push({ payload, options });
        return { data: { id: "email_1" }, error: null };
      },
    };
  },
}));
process.env.RESEND_API_KEY = "re_test";
const { relayClerkEmail } = await import("./mailer");

beforeEach(() => {
  sends.length = 0;
});

describe("relayClerkEmail", () => {
  const payload = { to_email_address: "person@example.test", subject: "Code", body: "<p>123456</p>" };

  test("passes the caller's idempotency key to Resend on every attempt", async () => {
    await relayClerkEmail(payload, { idempotencyKey: "clerk-email/msg_1" });
    await relayClerkEmail(payload, { idempotencyKey: "clerk-email/msg_1" });
    expect(sends.map((send) => send.options)).toEqual([
      { idempotencyKey: "clerk-email/msg_1" },
      { idempotencyKey: "clerk-email/msg_1" },
    ]);
  });

  test("sends without a key when none is given", async () => {
    await relayClerkEmail(payload);
    expect(sends[0]?.options).toBeUndefined();
  });
});
