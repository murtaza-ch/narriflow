import { describe, expect, test } from "bun:test";

import { createReviewBrowserIntents } from "./review-browser-intents";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("Review browser intents", () => {
  test("keeps create, resend, and delivery retry keys stable until success", () => {
    let sequence = 0;
    const intents = createReviewBrowserIntents({
      storage: memoryStorage(),
      createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    });
    const createRequest = {
      title: "Launch review",
      recipientEmails: ["reviewer@example.test"],
      items: [{ exportId: "export-1" }],
    };

    const create = intents.createRound("project-1", createRequest);
    expect(intents.createRound("project-1", createRequest).idempotencyKey).toBe(
      create.idempotencyKey,
    );
    const resend = intents.resendRound("project-1", "round-1");
    expect(intents.resendRound("project-1", "round-1").idempotencyKey).toBe(
      resend.idempotencyKey,
    );
    const retry = intents.retryNotification(
      "project-1",
      "round-1",
      "notification-1",
    );
    expect(
      intents.retryNotification(
        "project-1",
        "round-1",
        "notification-1",
      ).idempotencyKey,
    ).toBe(retry.idempotencyKey);
    expect(sequence).toBe(3);

    create.confirm();
    resend.confirm();
    retry.confirm();
    expect(intents.createRound("project-1", createRequest).idempotencyKey).not.toBe(
      create.idempotencyKey,
    );
    expect(intents.resendRound("project-1", "round-1").idempotencyKey).not.toBe(
      resend.idempotencyKey,
    );
    expect(
      intents.retryNotification(
        "project-1",
        "round-1",
        "notification-1",
      ).idempotencyKey,
    ).not.toBe(retry.idempotencyKey);
  });

  test("does not share a key between different rounds or notifications", () => {
    let sequence = 0;
    const intents = createReviewBrowserIntents({
      storage: memoryStorage(),
      createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    });

    expect(intents.resendRound("project-1", "round-1").idempotencyKey).not.toBe(
      intents.resendRound("project-1", "round-2").idempotencyKey,
    );
    expect(
      intents.retryNotification("project-1", "round-1", "notification-1")
        .idempotencyKey,
    ).not.toBe(
      intents.retryNotification("project-1", "round-1", "notification-2")
        .idempotencyKey,
    );
  });
});
