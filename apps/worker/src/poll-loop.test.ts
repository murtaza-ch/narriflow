import { describe, expect, test } from "bun:test";
import { createIsolatedPollLoop } from "./poll-loop";

describe("isolated worker poll loops", () => {
  test("billing reconciliation completes while an ingest tick remains busy", async () => {
    let releaseIngest!: () => void;
    const ingestBlocked = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    let accountsReconciled = 0;
    const ingest = createIsolatedPollLoop({
      name: "ingest",
      run: async () => {
        await ingestBlocked;
        return 1;
      },
      maximumConsecutiveFailures: 3,
    });
    const billing = createIsolatedPollLoop({
      name: "workspace_billing",
      run: async () => {
        accountsReconciled += 1;
        return 1;
      },
      maximumConsecutiveFailures: 3,
    });

    const ingestTick = ingest.tick();
    await billing.tick();

    expect(ingest.status().polling).toBe(true);
    expect(billing.status().polling).toBe(false);
    expect(accountsReconciled).toBe(1);
    releaseIngest();
    await ingestTick;
  });

  test("a hung billing provider does not block another worker loop", async () => {
    let releaseProvider!: () => void;
    const providerBlocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let notificationsProcessed = 0;
    const billing = createIsolatedPollLoop({
      name: "workspace_billing",
      run: async () => {
        await providerBlocked;
        return 1;
      },
      maximumConsecutiveFailures: 3,
    });
    const notifications = createIsolatedPollLoop({
      name: "notification_retry",
      run: async () => {
        notificationsProcessed += 1;
        return 1;
      },
      maximumConsecutiveFailures: 3,
    });

    const billingTick = billing.tick();
    await notifications.tick();

    expect(billing.status().polling).toBe(true);
    expect(notificationsProcessed).toBe(1);
    releaseProvider();
    await billingTick;
  });
});
