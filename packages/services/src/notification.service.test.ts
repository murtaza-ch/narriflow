import { describe, expect, spyOn, test } from "bun:test";
import {
  NotificationService,
  type NotificationLedgerRow,
  type NotificationMailInput,
  type NotificationProject,
  type NotificationStore,
  type WorkflowRunNotificationContext,
} from "./notification.service";

const NOW = new Date("2026-07-28T12:00:00.000Z");

class MemoryNotificationStore implements NotificationStore {
  readonly ledgers = new Map<string, NotificationLedgerRow>();
  project: NotificationProject | null = {
    id: "project-1",
    title: "Founder interview",
    notifyOnComplete: true,
    primaryEmail: "owner@example.com",
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2026-07-29T12:00:00.000Z"),
    clipCount: 4,
  };
  workflowContext: WorkflowRunNotificationContext | null = null;
  private nextId = 1;

  async getProject(projectId: string) {
    return this.project?.id === projectId ? this.project : null;
  }

  async listRetryable(input: { now: Date; limit: number }) {
    return [...this.ledgers.values()]
      .filter(
        (row) =>
          row.attemptCount < 3 &&
          (row.status === "pending" ||
            (row.status === "claimed" &&
              row.leaseExpiresAt !== null &&
              row.leaseExpiresAt.getTime() <= input.now.getTime())),
      )
      .slice(0, input.limit);
  }

  async insertOrFind(input: {
    projectId: string;
    sourceId: string;
    outcome:
      | "clips_ready"
      | "no_clips"
      | "generation_failed"
      | "import_failed"
      | "project_expiring";
  }) {
    const key = `${input.projectId}:${input.sourceId}:${input.outcome}`;
    const existing = this.ledgers.get(key);
    if (existing) return existing;

    const row: NotificationLedgerRow = {
      id: `ledger-${this.nextId++}`,
      ...input,
      status: "pending",
      leaseExpiresAt: null,
      attemptCount: 0,
      providerMessageId: null,
      sentAt: null,
    };
    this.ledgers.set(key, row);
    return row;
  }

  async claim(input: { id: string; now: Date; leaseExpiresAt: Date }) {
    const row = this.findById(input.id);
    const claimable =
      row.attemptCount < 3 &&
      (row.status === "pending" ||
        (row.status === "claimed" &&
          row.leaseExpiresAt !== null &&
          row.leaseExpiresAt.getTime() <= input.now.getTime()));
    if (!claimable) return false;
    row.status = "claimed";
    row.leaseExpiresAt = input.leaseExpiresAt;
    return true;
  }

  async markSent(input: {
    id: string;
    leaseExpiresAt: Date;
    providerMessageId: string | null;
    sentAt: Date;
  }) {
    const row = this.findById(input.id);
    if (!this.ownsLease(row, input.leaseExpiresAt)) return false;
    row.status = "sent";
    row.leaseExpiresAt = null;
    row.providerMessageId = input.providerMessageId;
    row.sentAt = input.sentAt;
    return true;
  }

  async markSkipped(input: { id: string; leaseExpiresAt: Date }) {
    const row = this.findById(input.id);
    if (!this.ownsLease(row, input.leaseExpiresAt)) return false;
    row.status = "skipped";
    row.leaseExpiresAt = null;
    return true;
  }

  async markDeliveryFailure(input: {
    id: string;
    leaseExpiresAt: Date;
    attemptCount: number;
    terminal: boolean;
  }) {
    const row = this.findById(input.id);
    if (!this.ownsLease(row, input.leaseExpiresAt)) return false;
    row.status = input.terminal ? "failed" : "pending";
    row.leaseExpiresAt = null;
    row.attemptCount = input.attemptCount;
    return true;
  }

  async getWorkflowRunContext() {
    return this.workflowContext;
  }

  seed(row: NotificationLedgerRow) {
    const key = `${row.projectId}:${row.sourceId}:${row.outcome}`;
    this.ledgers.set(key, row);
  }

  onlyLedger() {
    const rows = [...this.ledgers.values()];
    if (rows.length !== 1) throw new Error(`expected one ledger, got ${rows.length}`);
    return rows[0]!;
  }

  private findById(id: string) {
    const row = [...this.ledgers.values()].find((candidate) => candidate.id === id);
    if (!row) throw new Error(`ledger ${id} not found`);
    return row;
  }

  private ownsLease(row: NotificationLedgerRow, leaseExpiresAt: Date) {
    return (
      row.status === "claimed" &&
      row.leaseExpiresAt?.getTime() === leaseExpiresAt.getTime()
    );
  }
}

function serviceWith(
  store: MemoryNotificationStore,
  mailer: (input: NotificationMailInput) => Promise<{
    sent: boolean;
    id?: string;
    error?: string;
  }>,
  hasResendApiKey = true,
) {
  return new NotificationService({
    store,
    mailer,
    now: () => new Date(NOW),
    hasResendApiKey: () => hasResendApiKey,
  });
}

const input = {
  projectId: "project-1",
  sourceId: "run-1",
  outcome: "clips_ready" as const,
  deepLink: "https://app.narriflow.test/projects/project-1",
  clipCount: 4,
};

describe("NotificationService", () => {
  test("handoff durably reuses one pending ledger without provider delivery", async () => {
    const store = new MemoryNotificationStore();
    let sends = 0;
    const service = serviceWith(store, async () => {
      sends += 1;
      return { sent: true, id: "unexpected" };
    });

    const first = await service.handoff({
      projectId: input.projectId,
      sourceId: input.sourceId,
      outcome: input.outcome,
    });
    const replay = await service.handoff({
      projectId: input.projectId,
      sourceId: input.sourceId,
      outcome: input.outcome,
    });

    expect(first).toEqual({ ledgerId: "ledger-1", status: "pending" });
    expect(replay).toEqual(first);
    expect(store.ledgers.size).toBe(1);
    expect(store.onlyLedger().status).toBe("pending");
    expect(sends).toBe(0);
  });

  test("send-once under concurrent enqueueAndSend", async () => {
    const store = new MemoryNotificationStore();
    let sends = 0;
    const service = serviceWith(store, async () => {
      sends += 1;
      await Promise.resolve();
      return { sent: true, id: "email-1" };
    });

    await Promise.all([
      service.enqueueAndSend(input),
      service.enqueueAndSend(input),
      service.enqueueAndSend(input),
    ]);

    expect(sends).toBe(1);
    expect(store.onlyLedger().status).toBe("sent");
    expect(store.onlyLedger().providerMessageId).toBe("email-1");
  });

  test("does not double-send after a transient failure then success", async () => {
    const store = new MemoryNotificationStore();
    let sends = 0;
    const service = serviceWith(store, async () => {
      sends += 1;
      return sends === 1
        ? { sent: false, error: "temporary provider outage" }
        : { sent: true, id: "email-2" };
    });

    expect((await service.enqueueAndSend(input)).status).toBe("pending");
    expect((await service.enqueueAndSend(input)).status).toBe("sent");
    expect((await service.enqueueAndSend(input)).status).toBe("sent");
    expect(sends).toBe(2);
    expect(store.onlyLedger().attemptCount).toBe(1);
  });

  test("re-sends a transient-failure pending row exactly once through retry polling", async () => {
    const store = new MemoryNotificationStore();
    let sends = 0;
    const service = serviceWith(store, async () => {
      sends += 1;
      return sends === 1
        ? { sent: false, error: "temporary provider outage" }
        : { sent: true, id: "email-retried" };
    });

    expect((await service.enqueueAndSend(input)).status).toBe("pending");
    const firstPoll = await service.resendPendingNotifications(10, () => ({
      deepLink: input.deepLink,
    }));
    const secondPoll = await service.resendPendingNotifications(10, () => ({
      deepLink: input.deepLink,
    }));

    expect(firstPoll).toEqual({
      scanned: 1,
      claimed: 1,
      sent: 1,
      pending: 0,
      failed: 0,
      skipped: 0,
      claimLost: 0,
    });
    expect(secondPoll.scanned).toBe(0);
    expect(sends).toBe(2);
    expect(store.onlyLedger().status).toBe("sent");
  });

  test("does not retry sent notification rows", async () => {
    const store = new MemoryNotificationStore();
    store.seed({
      id: "ledger-sent",
      projectId: input.projectId,
      sourceId: input.sourceId,
      outcome: input.outcome,
      status: "sent",
      leaseExpiresAt: null,
      attemptCount: 1,
      providerMessageId: "email-existing",
      sentAt: NOW,
    });
    let sends = 0;
    const service = serviceWith(store, async () => {
      sends += 1;
      return { sent: true };
    });

    const result = await service.resendPendingNotifications(10, () => ({
      deepLink: input.deepLink,
    }));

    expect(result.scanned).toBe(0);
    expect(sends).toBe(0);
  });

  test("does not retry skipped notification rows", async () => {
    const store = new MemoryNotificationStore();
    store.seed({
      id: "ledger-skipped",
      projectId: input.projectId,
      sourceId: input.sourceId,
      outcome: input.outcome,
      status: "skipped",
      leaseExpiresAt: null,
      attemptCount: 0,
      providerMessageId: null,
      sentAt: null,
    });
    let sends = 0;
    const service = serviceWith(store, async () => {
      sends += 1;
      return { sent: true };
    });

    const result = await service.resendPendingNotifications(10, () => ({
      deepLink: input.deepLink,
    }));

    expect(result.scanned).toBe(0);
    expect(sends).toBe(0);
  });

  test("retry polling reclaims an expired lease", async () => {
    const store = new MemoryNotificationStore();
    store.seed({
      id: "ledger-expired",
      projectId: input.projectId,
      sourceId: input.sourceId,
      outcome: input.outcome,
      status: "claimed",
      leaseExpiresAt: new Date(NOW.getTime() - 1),
      attemptCount: 0,
      providerMessageId: null,
      sentAt: null,
    });
    let sends = 0;
    const service = serviceWith(store, async ({ idempotencyKey }) => {
      sends += 1;
      expect(idempotencyKey).toBe("notification-ledger-ledger-expired");
      return { sent: true, id: "email-reclaimed" };
    });

    const result = await service.resendPendingNotifications(10, () => ({
      deepLink: input.deepLink,
    }));

    expect(result.sent).toBe(1);
    expect(sends).toBe(1);
    expect(store.onlyLedger().status).toBe("sent");
  });

  test("stops retrying after three delivery failures", async () => {
    const store = new MemoryNotificationStore();
    let sends = 0;
    const service = serviceWith(store, async () => {
      sends += 1;
      return { sent: false, error: "provider unavailable" };
    });

    expect((await service.enqueueAndSend(input)).status).toBe("pending");
    expect((await service.enqueueAndSend(input)).status).toBe("pending");
    expect((await service.enqueueAndSend(input)).status).toBe("failed");
    expect((await service.enqueueAndSend(input)).status).toBe("failed");
    expect(sends).toBe(3);
    expect(store.onlyLedger().attemptCount).toBe(3);
  });

  test("marks a notification skipped when the user has no primary email", async () => {
    const store = new MemoryNotificationStore();
    store.project = { ...store.project!, primaryEmail: null };
    let sends = 0;
    const service = serviceWith(store, async () => {
      sends += 1;
      return { sent: true };
    });

    expect((await service.enqueueAndSend(input)).status).toBe("skipped");
    expect(store.onlyLedger().status).toBe("skipped");
    expect(sends).toBe(0);
  });

  test("marks a notification skipped when RESEND_API_KEY is unset", async () => {
    const store = new MemoryNotificationStore();
    let sends = 0;
    const service = serviceWith(
      store,
      async () => {
        sends += 1;
        return { sent: true };
      },
      false,
    );

    expect((await service.enqueueAndSend(input)).status).toBe("skipped");
    expect(store.onlyLedger().status).toBe("skipped");
    expect(sends).toBe(0);
  });

  test("does not create a ledger when project notifications are disabled", async () => {
    const store = new MemoryNotificationStore();
    store.project = { ...store.project!, notifyOnComplete: false };
    const service = serviceWith(store, async () => ({ sent: true }));

    expect((await service.enqueueAndSend(input)).status).toBe("disabled");
    expect(store.ledgers.size).toBe(0);
  });

  test("expiry warning is required even when completion notifications are disabled", async () => {
    const store = new MemoryNotificationStore();
    store.project = { ...store.project!, notifyOnComplete: false };
    let delivered: NotificationMailInput | null = null;
    const service = serviceWith(store, async (mail) => {
      delivered = mail;
      return { sent: true, id: "expiry-email" };
    });

    const result = await service.enqueueAndSend({
      projectId: "project-1",
      sourceId: "project-1",
      outcome: "project_expiring",
      deepLink: "https://app.narriflow.test/settings/billing",
    });

    expect(result.status).toBe("sent");
    expect(delivered?.outcome).toBe("project_expiring");
    expect(delivered?.expiresAt).toBe("2026-07-29T12:00:00.000Z");
  });

  test("expiry warning skips an unverified primary email", async () => {
    const store = new MemoryNotificationStore();
    store.project = { ...store.project!, emailVerifiedAt: null };
    let sends = 0;
    const service = serviceWith(store, async () => {
      sends += 1;
      return { sent: true };
    });

    const result = await service.enqueueAndSend({
      projectId: "project-1",
      sourceId: "project-1",
      outcome: "project_expiring",
      deepLink: "https://app.narriflow.test/settings/billing",
    });

    expect(result.status).toBe("skipped");
    expect(sends).toBe(0);
  });
});

 test("reports a replaced notification claim instead of sent", async () => {
  const store = new MemoryNotificationStore();
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const sender = serviceWith(store, async () => {
    await store.claim({ id: store.onlyLedger().id, now: new Date(NOW.getTime() + 300_000), leaseExpiresAt: new Date(NOW.getTime() + 600_000) });
    return { sent: true, id: "late-message" };
  });
  try {
    expect((await sender.enqueueAndSend(input)).status).toBe("claim_lost");
    expect(warnings.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(expect.objectContaining({ message: "notification_claim_lost", ledgerId: "ledger-1", projectId: "project-1", sourceId: "run-1", outcome: "clips_ready", settlement: "sent" }));
    expect(store.onlyLedger().status).toBe("claimed");
  } finally { warnings.mockRestore(); }
});

for (const scenario of ["sent", "pending", "failed", "recipient", "unverified", "disabled_provider", "missing_project", "disabled_project", "invalid_outcome", "missing_input"] as const) {
  test(`notification polling reports lost claims during ${scenario} settlement`, async () => {
    const store = new MemoryNotificationStore();
    const sender = serviceWith(store, async () => ({ sent: scenario === "sent", error: "provider unavailable" }), scenario !== "disabled_provider");
    await sender.handoff(input);
    if (scenario === "failed") store.onlyLedger().attemptCount = 2;
    if (scenario === "recipient") store.project!.primaryEmail = null;
    if (scenario === "unverified") {
      store.onlyLedger().outcome = "project_expiring";
      store.project!.emailVerifiedAt = null;
    }
    if (scenario === "missing_project") store.project = null;
    if (scenario === "disabled_project") store.project!.notifyOnComplete = false;
    if (scenario === "invalid_outcome") store.onlyLedger().outcome = "unknown";
    // Simulate another owner settling just before this owner's compare-and-set.
    const late = async () => { store.onlyLedger().status = "sent"; return false; };
    store.markSent = late;
    store.markSkipped = late;
    store.markDeliveryFailure = late;
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await sender.resendPendingNotifications(10, () => scenario === "missing_input" ? null : { deepLink: input.deepLink })).toEqual({ scanned: 1, claimed: 1, sent: 0, pending: 0, failed: 0, skipped: 0, claimLost: 1 });
      expect(warnings.mock.calls.map(([value]) => JSON.parse(value)).filter((entry) => entry.message === "notification_claim_lost")).toHaveLength(1);
    } finally { warnings.mockRestore(); }
  });
}

test("a late notification failure cannot reverse a replacement's successful settlement", async () => {
  const store = new MemoryNotificationStore();
  const replacement = new NotificationService({ store, now: () => new Date(NOW.getTime() + 300_000), hasResendApiKey: () => true, mailer: async () => ({ sent: true, id: "current-message" }) });
  const original = serviceWith(store, async () => {
    await replacement.enqueueAndSend(input);
    return { sent: false, error: "late failure" };
  });
  expect((await original.enqueueAndSend(input)).status).toBe("claim_lost");
  expect((await replacement.enqueueAndSend(input)).status).toBe("sent");
  expect(store.onlyLedger()).toMatchObject({ status: "sent", attemptCount: 0, providerMessageId: "current-message" });
});
