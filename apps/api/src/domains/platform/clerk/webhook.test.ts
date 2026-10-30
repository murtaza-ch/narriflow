import { beforeEach, describe, expect, test } from "bun:test";
import {
  handleClerkWebhook,
  type ClerkWebhookDependencies,
  type ClerkWebhookEvent,
} from "./webhook";

const SECRET = "whsec_test";
const headers = { "svix-id": "msg_1", "svix-timestamp": "1700000000", "svix-signature": "v1,sig" };

let event: ClerkWebhookEvent;
let verifyCalls: Array<{ rawBody: string; svixId: string; secret: string }>;
let verifyFails: boolean;
/** Delivery log with the claim semantics of `claimWebhookDelivery`. */
let deliveryStatus: Map<string, string>;
let recordFailures: string[];
let applied: string[];
let logs: Array<Record<string, unknown>>;
let relay: { sent: boolean; error?: string; reason?: string };
let syncFails: boolean;
let relayDeliveryIds: string[];
let relayGate: Promise<void>;

const deps: ClerkWebhookDependencies = {
  webhookSecret: SECRET,
  verify: (rawBody, signature, secret) => {
    verifyCalls.push({ rawBody, svixId: signature.id, secret });
    if (verifyFails) throw new Error("No matching signature found for sk_internal_detail");
    return event;
  },
  claimDelivery: async ({ eventId }) => {
    const status = deliveryStatus.get(eventId);
    if (status === "success") return "replay";
    if (status === "processing") return "in_progress";
    deliveryStatus.set(eventId, "processing");
    return "claimed";
  },
  recordDeliveryLog: async (input) => {
    if (recordFailures.includes(input.status)) {
      recordFailures.splice(recordFailures.indexOf(input.status), 1);
      throw new Error("db: log write failed");
    }
    deliveryStatus.set(input.eventId, input.status);
    logs.push(input);
  },
  syncUser: async (payload) => {
    if (syncFails) throw new Error("db: connection to 10.0.0.5 refused");
    applied.push(`sync:${String(payload.id)}`);
  },
  markUserDeleted: async (clerkId) => {
    applied.push(`delete:${clerkId}`);
  },
  relayEmail: async (_payload, deliveryId) => {
    applied.push("relay");
    relayDeliveryIds.push(deliveryId);
    await relayGate;
    return relay;
  },
};

const withId = (id: string) => ({ ...headers, "svix-id": id });

function post(body = '{"raw":  "bytes"}', extra: Record<string, string> = headers): Request {
  return new Request("http://localhost:4000/api/webhooks/clerk", {
    method: "POST",
    headers: extra,
    body,
  });
}

beforeEach(() => {
  event = { type: "user.created", data: { id: "user_1" } };
  verifyCalls = [];
  verifyFails = false;
  deliveryStatus = new Map();
  recordFailures = [];
  relayDeliveryIds = [];
  relayGate = Promise.resolve();
  applied = [];
  logs = [];
  relay = { sent: true };
  syncFails = false;
});

describe("Clerk webhook adapter", () => {
  test("verifies the original request text with the injected secret", async () => {
    const raw = '{"type":"user.created",  "data":{"id":"user_1"}}';
    const response = await handleClerkWebhook(post(raw), deps);
    expect(response.status).toBe(200);
    expect(verifyCalls).toEqual([{ rawBody: raw, svixId: "msg_1", secret: SECRET }]);
  });

  test.each(["svix-id", "svix-timestamp", "svix-signature"])("%s is required", async (name) => {
    const partial = { ...headers } as Record<string, string>;
    delete partial[name];
    const response = await handleClerkWebhook(post("{}", partial), deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing Svix signature headers" });
    expect(verifyCalls).toEqual([]);
  });

  test("a bad signature is a 400 that records nothing and hides the verifier's detail", async () => {
    verifyFails = true;
    const response = await handleClerkWebhook(post(), deps);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("sk_internal_detail");
    expect(applied).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("a verified body that is not a Clerk event is rejected", async () => {
    event = { type: 5 } as unknown as ClerkWebhookEvent;
    const response = await handleClerkWebhook(post(), deps);
    expect(response.status).toBe(400);
    expect(logs).toEqual([]);
  });

  test("an already successful delivery is acknowledged without being applied again", async () => {
    deliveryStatus.set("msg_1", "success");
    const response = await handleClerkWebhook(post(), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, replay: true });
    expect(applied).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("a delivery being processed by another handler is refused so Clerk redelivers it", async () => {
    deliveryStatus.set("msg_1", "processing");
    const response = await handleClerkWebhook(post(), deps);
    expect(response.status).toBe(409);
    expect(applied).toEqual([]);
  });

  test("a previously failed delivery is retried", async () => {
    deliveryStatus.set("msg_1", "failed");
    const response = await handleClerkWebhook(post(), deps);
    expect(response.status).toBe(200);
    expect(applied).toEqual(["sync:user_1"]);
  });

  test("user.created and user.updated sync the user and record success", async () => {
    for (const type of ["user.created", "user.updated"]) {
      event = { type, data: { id: "user_9" } };
      expect((await handleClerkWebhook(post("{}", withId(`msg_${type}`)), deps)).status).toBe(200);
    }
    expect(applied).toEqual(["sync:user_9", "sync:user_9"]);
    expect(logs.at(-1)).toEqual({
      provider: "clerk",
      eventId: "msg_user.updated",
      eventType: "user.updated",
      status: "success",
      payload: { type: "user.updated", eventId: "msg_user.updated", subjectId: "user_9" },
    });
  });

  test("user.deleted marks the user deleted; a payload without an id is a no-op success", async () => {
    event = { type: "user.deleted", data: { id: "user_9" } };
    await handleClerkWebhook(post("{}", withId("msg_a")), deps);
    event = { type: "user.deleted", data: {} };
    expect((await handleClerkWebhook(post("{}", withId("msg_b")), deps)).status).toBe(200);
    expect(applied).toEqual(["delete:user_9"]);
  });

  test("email.* events are relayed and a relay failure records failure with a 500", async () => {
    event = { type: "email.created", data: { to_email_address: "a@example.test", subject: "Code" } };
    expect((await handleClerkWebhook(post(), deps)).status).toBe(200);
    relay = { sent: false, reason: "Resend rejected" };
    const response = await handleClerkWebhook(post("{}", withId("msg_2")), deps);
    expect(response.status).toBe(500);
    expect(applied).toEqual(["relay", "relay"]);
    expect(logs.at(-1)).toMatchObject({
      status: "failed",
      payload: { error: "Resend rejected", subjectId: null },
    });
  });

  test("an email event without a recipient and subject is ignored but acknowledged", async () => {
    event = { type: "email.created", data: { body: "x" } };
    expect((await handleClerkWebhook(post(), deps)).status).toBe(200);
    expect(applied).toEqual([]);
  });

  test("unrelated event types are acknowledged and recorded", async () => {
    event = { type: "session.created", data: { id: "sess_1" } };
    expect((await handleClerkWebhook(post(), deps)).status).toBe(200);
    expect(logs).toHaveLength(1);
  });

  test("a processing failure is logged internally and returns a 500 without the cause", async () => {
    syncFails = true;
    const response = await handleClerkWebhook(post(), deps);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("10.0.0.5");
    expect(logs).toEqual([
      {
        provider: "clerk",
        eventId: "msg_1",
        eventType: "user.created",
        status: "failed",
        payload: {
          type: "user.created",
          eventId: "msg_1",
          subjectId: "user_1",
          error: "db: connection to 10.0.0.5 refused",
        },
      },
    ]);
  });
});

describe("Clerk email relay is retry-safe", () => {
  const emailEvent = (): ClerkWebhookEvent => ({
    type: "email.created",
    data: { to_email_address: "person@example.test", subject: "Sign-in code", body: "123456" },
  });

  test("overlapping deliveries of one event relay one email", async () => {
    event = emailEvent();
    let release!: () => void;
    relayGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = handleClerkWebhook(post(), deps);
    const second = await handleClerkWebhook(post(), deps);
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(applied).toEqual(["relay"]);
  });

  test("a send that succeeded before the log write failed is retried under the same delivery id", async () => {
    event = emailEvent();
    recordFailures = ["success", "failed"];
    expect((await handleClerkWebhook(post(), deps).catch(() => null))).toBeNull();
    // The lost log leaves the claim; Clerk redelivers once the lease has run out.
    deliveryStatus.set("msg_1", "failed");
    expect((await handleClerkWebhook(post(), deps)).status).toBe(200);
    // Both attempts carry the Svix id the Resend idempotency key is derived from.
    expect(relayDeliveryIds).toEqual(["msg_1", "msg_1"]);
  });
});
