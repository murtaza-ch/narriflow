import { describe, expect, test } from "bun:test";
import {
  createInMemoryReviewNotificationStore,
  createReviewNotificationDelivery,
  type ReviewNotificationMailInput,
} from "./review-notification.service";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const now = new Date("2026-08-31T10:00:00.000Z");

function seededStore(to = "client@example.test") {
  return createInMemoryReviewNotificationStore([{
    id: id(1),
    reviewRoundId: id(2),
    projectId: id(3),
    recipientId: id(4),
    kind: "round_sent",
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: now,
    claimId: null,
    leaseExpiresAt: null,
    providerMessageId: null,
    failureCode: null,
    sentAt: null,
    createdAt: now,
    delivery: {
      to,
      projectTitle: "Quarterly interview",
      roundNumber: 2,
      audience: "guest",
      actionUrl: "https://app.example.test/review/secret",
    },
  }]);
}

describe("review notification delivery", () => {
  test("leaves queued notifications untouched while delivery is paused and resumes them", async () => {
    const store = seededStore();
    let enabled = false;
    let sends = 0;
    const delivery = createReviewNotificationDelivery({
      store,
      now: () => now,
      createClaimId: () => id(10),
      admissionEnabled: () => enabled,
      mailer: async () => {
        sends += 1;
        return { sent: true, id: "provider-1" };
      },
    });

    expect(await delivery.processDue(10)).toEqual([]);
    expect(await delivery.deliver(id(1))).toEqual({
      status: "disabled",
      notificationId: id(1),
      failureCode: null,
    });
    expect(await store.inspect(id(1))).toMatchObject({
      status: "pending",
      attemptCount: 0,
      claimId: null,
    });
    expect(sends).toBe(0);

    enabled = true;
    expect(await delivery.deliver(id(1))).toMatchObject({ status: "sent" });
    expect(sends).toBe(1);
  });

  test("keeps a provider timeout pending and exposes the failure for retry", async () => {
    const store = seededStore();
    const delivery = createReviewNotificationDelivery({
      store,
      now: () => now,
      createClaimId: () => id(10),
      mailer: async () => { throw new Error("provider timeout with private detail"); },
    });

    expect(await delivery.deliver(id(1))).toMatchObject({
      status: "pending",
      failureCode: "review_notification_provider_unavailable",
    });
    const visible = await store.inspect(id(1));
    expect(visible).toMatchObject({ status: "pending", attemptCount: 1, failureCode: "review_notification_provider_unavailable" });
    expect(JSON.stringify(visible)).not.toContain("private detail");
  });

  test("uses one provider idempotency key after a lost success response", async () => {
    const store = seededStore();
    const accepted = new Map<string, string>();
    let calls = 0;
    const mailer = async (input: ReviewNotificationMailInput) => {
      calls += 1;
      const providerId = accepted.get(input.idempotencyKey) ?? `provider-${accepted.size + 1}`;
      accepted.set(input.idempotencyKey, providerId);
      if (calls === 1) throw new Error("response lost after acceptance");
      return { sent: true, id: providerId };
    };
    let clock = now;
    const delivery = createReviewNotificationDelivery({
      store,
      now: () => clock,
      createClaimId: () => calls === 0 ? id(10) : id(11),
      retryDelayMs: () => 1_000,
      mailer,
    });

    expect((await delivery.deliver(id(1))).status).toBe("pending");
    clock = new Date(now.getTime() + 1_001);
    expect((await delivery.deliver(id(1))).status).toBe("sent");
    expect(accepted.size).toBe(1);
    expect((await store.inspect(id(1)))?.providerMessageId).toBe("provider-1");
  });

  test("fences duplicate worker claims", async () => {
    const store = seededStore();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    const delivery = createReviewNotificationDelivery({
      store,
      now: () => now,
      createClaimId: (() => { let value = 20; return () => id(value++); })(),
      mailer: async () => { sends += 1; await wait; return { sent: true, id: "provider-1" }; },
    });

    const first = delivery.deliver(id(1));
    await Promise.resolve();
    const duplicate = await delivery.deliver(id(1));
    release();

    expect(duplicate.status).toBe("already_claimed");
    expect((await first).status).toBe("sent");
    expect(sends).toBe(1);
  });

  test("does not report sent when another delivery takes over the expired claim", async () => {
    const store = seededStore();
    let clock = now;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondWait = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let calls = 0;
    const delivery = createReviewNotificationDelivery({
      store,
      now: () => clock,
      leaseMs: 1_000,
      createClaimId: (() => {
        let value = 20;
        return () => id(value++);
      })(),
      mailer: async () => {
        calls += 1;
        if (calls === 1) {
          markFirstStarted();
          await firstWait;
          return { sent: true, id: "provider-1" };
        }
        markSecondStarted();
        await secondWait;
        return { sent: true, id: "provider-1" };
      },
    });

    const first = delivery.deliver(id(1));
    await firstStarted;
    clock = new Date(now.getTime() + 1_001);
    const second = delivery.deliver(id(1));
    await secondStarted;
    releaseFirst();

    expect(await first).toEqual({
      status: "already_claimed",
      notificationId: id(1),
      failureCode: null,
    });

    releaseSecond();
    expect(await second).toMatchObject({ status: "sent" });
    expect(await store.inspect(id(1))).toMatchObject({
      status: "sent",
      providerMessageId: "provider-1",
    });
  });

  test("does not report or log failure after another delivery takes over the expired claim", async () => {
    const store = seededStore();
    let clock = now;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondWait = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let calls = 0;
    const delivery = createReviewNotificationDelivery({
      store,
      now: () => clock,
      leaseMs: 1_000,
      createClaimId: (() => {
        let value = 30;
        return () => id(value++);
      })(),
      mailer: async () => {
        calls += 1;
        if (calls === 1) {
          markFirstStarted();
          await firstWait;
          return { sent: false };
        }
        markSecondStarted();
        await secondWait;
        return { sent: true, id: "provider-1" };
      },
    });
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const first = delivery.deliver(id(1));
      await firstStarted;
      clock = new Date(now.getTime() + 1_001);
      const second = delivery.deliver(id(1));
      await secondStarted;
      releaseFirst();

      expect(await first).toEqual({
        status: "already_claimed",
        notificationId: id(1),
        failureCode: null,
      });
      expect(warnings).toEqual([]);

      releaseSecond();
      expect(await second).toMatchObject({ status: "sent" });
      expect(await store.inspect(id(1))).toMatchObject({ status: "sent" });
    } finally {
      releaseFirst();
      releaseSecond();
      console.warn = originalWarn;
    }
  });

  test("fails an invalid recipient without calling the provider", async () => {
    const store = seededStore("not-an-email");
    let sends = 0;
    const delivery = createReviewNotificationDelivery({
      store,
      now: () => now,
      createClaimId: () => id(10),
      mailer: async () => { sends += 1; return { sent: true }; },
    });

    expect(await delivery.deliver(id(1))).toMatchObject({
      status: "failed",
      failureCode: "review_notification_recipient_invalid",
    });
    expect(sends).toBe(0);
  });
});
