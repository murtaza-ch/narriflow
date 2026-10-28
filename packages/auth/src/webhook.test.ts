import { describe, expect, test } from "bun:test";
import { Webhook } from "svix";
import { verifyClerkWebhook } from "./webhook";

const secret = `whsec_${Buffer.from("narriflow-test-signing-secret-0123456789").toString("base64")}`;

function signed(body: string, at = new Date()) {
  const id = "msg_test_1";
  const timestamp = String(Math.floor(at.getTime() / 1000));
  return { id, timestamp, signature: new Webhook(secret).sign(id, at, body) };
}

describe("Clerk webhook signature", () => {
  const body = JSON.stringify({ type: "user.created", data: { id: "user_1" } });

  test("accepts the exact signed bytes and returns the parsed event", () => {
    expect(verifyClerkWebhook(body, signed(body), secret)).toEqual({
      type: "user.created",
      data: { id: "user_1" },
    });
  });

  test("rejects a body that differs by whitespace, so reserialization is detectable", () => {
    const headers = signed(body);
    expect(() => verifyClerkWebhook(`${body} `, headers, secret)).toThrow();
    expect(() => verifyClerkWebhook(JSON.stringify(JSON.parse(body), null, 1), headers, secret)).toThrow();
  });

  test("rejects a signature made with another secret", () => {
    const other = `whsec_${Buffer.from("another-signing-secret-0123456789ab").toString("base64")}`;
    const headers = { ...signed(body), signature: new Webhook(other).sign("msg_test_1", new Date(), body) };
    expect(() => verifyClerkWebhook(body, headers, secret)).toThrow();
  });

  test("rejects a replayed delivery outside the timestamp tolerance", () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    expect(() => verifyClerkWebhook(body, signed(body, old), secret)).toThrow();
  });
});
