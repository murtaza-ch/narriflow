import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const sends: Array<{ payload: unknown; options: unknown }> = [];
const keys: string[] = [];
mock.module("resend", () => ({
  Resend: class {
    constructor(key: string) {
      keys.push(key);
    }
    emails = {
      send: async (payload: unknown, options: unknown) => {
        sends.push({ payload, options });
        return { data: { id: "email_1" }, error: null };
      },
    };
  },
}));
const { mailerConfig, relayClerkEmail, sendEmail } = await import("./mailer");

beforeEach(() => {
  sends.length = 0;
  keys.length = 0;
  // The Worker has no process environment; nothing here may depend on one.
  delete process.env.RESEND_API_KEY;
  delete process.env.NARRIFLOW_EMAIL_FROM;
});

describe("relayClerkEmail", () => {
  const payload = { to_email_address: "person@example.test", subject: "Code", body: "<p>123456</p>" };
  const config = { apiKey: "re_test" };

  test("passes the caller's idempotency key to Resend on every attempt", async () => {
    await relayClerkEmail(payload, { ...config, idempotencyKey: "clerk-email/msg_1" });
    await relayClerkEmail(payload, { ...config, idempotencyKey: "clerk-email/msg_1" });
    expect(sends.map((send) => send.options)).toEqual([
      { idempotencyKey: "clerk-email/msg_1" },
      { idempotencyKey: "clerk-email/msg_1" },
    ]);
  });

  test("sends without a key when none is given", async () => {
    await relayClerkEmail(payload, config);
    expect(sends[0]?.options).toBeUndefined();
  });
});

describe("sendEmail", () => {
  test("sends with the key and sender the caller passes, not the process environment", async () => {
    const result = await sendEmail({ to: "a@example.test", subject: "Hi", text: "Hello" }, { apiKey: "re_passed", from: "Narriflow <hi@example.test>" });
    expect(result).toEqual({ sent: true, id: "email_1" });
    expect(keys).toEqual(["re_passed"]);
    expect(sends[0]?.payload).toMatchObject({ from: "Narriflow <hi@example.test>" });
  });

  test("reports and logs why nothing was sent without a key", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const result = await sendEmail({ to: "a@example.test", subject: "Hi", text: "Hello" }, {});
    expect(result).toEqual({ sent: false, reason: "RESEND_API_KEY is not configured" });
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ message: "email_not_sent", reason: "RESEND_API_KEY is not configured" });
    warn.mockRestore();
  });

  test("reads settings from a service environment", () => {
    expect(mailerConfig({ RESEND_API_KEY: " re_x ", NARRIFLOW_EMAIL_FROM: "" })).toEqual({ apiKey: "re_x", from: undefined });
  });
});
