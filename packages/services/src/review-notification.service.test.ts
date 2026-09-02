import { describe, expect, test } from "bun:test";
import {
  ReviewNotificationService,
  type ReviewNotificationContext,
  type ReviewNotificationLedgerRow,
  type ReviewNotificationMailInput,
  type ReviewNotificationStore,
} from "./review-notification.service";

class MemoryReviewNotificationStore implements ReviewNotificationStore {
  readonly rows = new Map<string, ReviewNotificationLedgerRow>();
  readonly contexts = new Map<string, ReviewNotificationContext>();

  seed(row: ReviewNotificationLedgerRow, context: ReviewNotificationContext) {
    this.rows.set(row.id, row);
    this.contexts.set(row.id, context);
  }

  async listDue(now: Date, limit: number) {
    return [...this.rows.values()]
      .filter((row) =>
        row.attemptCount < 3 &&
        row.nextAttemptAt <= now &&
        (row.status === "pending" ||
          (row.status === "claimed" &&
            row.leaseExpiresAt !== null &&
            row.leaseExpiresAt <= now)),
      )
      .slice(0, limit);
  }

  async claim(id: string, now: Date, leaseExpiresAt: Date) {
    const row = this.rows.get(id);
    if (
      !row ||
      row.attemptCount >= 3 ||
      row.nextAttemptAt > now ||
      (row.status !== "pending" &&
        !(row.status === "claimed" && row.leaseExpiresAt && row.leaseExpiresAt <= now))
    ) {
      return false;
    }
    this.rows.set(id, { ...row, status: "claimed", leaseExpiresAt });
    return true;
  }

  async getContext(id: string) {
    return this.contexts.get(id) ?? null;
  }

  async markSent(id: string, leaseExpiresAt: Date, providerMessageId: string | null, sentAt: Date) {
    const row = this.owned(id, leaseExpiresAt);
    if (!row) return false;
    this.rows.set(id, { ...row, status: "sent", leaseExpiresAt: null, providerMessageId, sentAt });
    return true;
  }

  async markFailed(
    id: string,
    leaseExpiresAt: Date,
    attemptCount: number,
    nextAttemptAt: Date,
    terminal: boolean,
    failureCode: string,
  ) {
    const row = this.owned(id, leaseExpiresAt);
    if (!row) return false;
    this.rows.set(id, {
      ...row,
      status: terminal ? "failed" : "pending",
      leaseExpiresAt: null,
      attemptCount,
      nextAttemptAt,
      failureCode,
    });
    return true;
  }

  async retry(reviewRoundId: string, id: string, now: Date) {
    const row = this.rows.get(id);
    if (!row || row.reviewRoundId !== reviewRoundId || row.status !== "failed") return false;
    this.rows.set(id, {
      ...row,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      failureCode: null,
    });
    return true;
  }

  private owned(id: string, leaseExpiresAt: Date) {
    const row = this.rows.get(id);
    return row?.status === "claimed" && row.leaseExpiresAt?.getTime() === leaseExpiresAt.getTime()
      ? row
      : null;
  }
}

function ledger(overrides: Partial<ReviewNotificationLedgerRow> = {}): ReviewNotificationLedgerRow {
  return {
    id: crypto.randomUUID(),
    reviewRoundId: crypto.randomUUID(),
    kind: "round_sent",
    scopeKey: "round",
    status: "pending",
    leaseExpiresAt: null,
    attemptCount: 0,
    nextAttemptAt: new Date("2026-09-02T10:00:00Z"),
    providerMessageId: null,
    sentAt: null,
    failureCode: null,
    ...overrides,
  };
}

function context(row: ReviewNotificationLedgerRow): ReviewNotificationContext {
  return {
    ledgerId: row.id,
    recipient: "reviewer@example.test",
    projectTitle: "Launch film",
    roundTitle: "Client review 03",
    reviewPath: "/review/secret-capability",
    kind: row.kind,
  };
}

function service(
  store: MemoryReviewNotificationStore,
  send: (input: ReviewNotificationMailInput) => Promise<{ sent: boolean; id?: string; retryable?: boolean; code?: string }>,
) {
  return new ReviewNotificationService({
    store,
    mailer: send,
    now: () => new Date("2026-09-02T10:00:00Z"),
    leaseMs: 60_000,
    retryDelayMs: 1_000,
    enabled: () => true,
  });
}

describe("ReviewNotificationService", () => {
  test("keeps a provider timeout retryable and reuses the ledger idempotency key", async () => {
    const store = new MemoryReviewNotificationStore();
    const row = ledger();
    store.seed(row, context(row));
    const keys: string[] = [];
    const sender = service(store, async (input) => {
      keys.push(input.idempotencyKey);
      if (keys.length === 1) throw new Error("provider timeout");
      return { sent: true, id: "provider-1" };
    });

    expect(await sender.deliverDue(10, "https://app.example.test")).toMatchObject({ pending: 1, sent: 0 });
    store.rows.set(row.id, { ...store.rows.get(row.id)!, nextAttemptAt: new Date("2026-09-02T10:00:00Z") });
    expect(await sender.deliverDue(10, "https://app.example.test")).toMatchObject({ pending: 0, sent: 1 });
    expect(keys).toEqual([`review-notification-${row.id}`, `review-notification-${row.id}`]);
  });

  test("a lost success response cannot create a second provider message", async () => {
    const store = new MemoryReviewNotificationStore();
    const row = ledger();
    store.seed(row, context(row));
    const accepted = new Map<string, string>();
    const sender = service(store, async (input) => {
      const existing = accepted.get(input.idempotencyKey);
      if (existing) return { sent: true, id: existing };
      accepted.set(input.idempotencyKey, "provider-once");
      throw new Error("connection dropped after acceptance");
    });

    await sender.deliverDue(10, "https://app.example.test");
    store.rows.set(row.id, { ...store.rows.get(row.id)!, nextAttemptAt: new Date("2026-09-02T10:00:00Z") });
    await sender.deliverDue(10, "https://app.example.test");

    expect(accepted).toEqual(new Map([[`review-notification-${row.id}`, "provider-once"]]));
    expect(store.rows.get(row.id)).toMatchObject({ status: "sent", providerMessageId: "provider-once" });
  });

  test("duplicate worker claims deliver one message", async () => {
    const store = new MemoryReviewNotificationStore();
    const row = ledger();
    store.seed(row, context(row));
    let sends = 0;
    const sender = service(store, async () => {
      sends += 1;
      return { sent: true, id: "provider-1" };
    });

    await Promise.all([
      sender.deliverDue(10, "https://app.example.test"),
      sender.deliverDue(10, "https://app.example.test"),
    ]);

    expect(sends).toBe(1);
    expect(store.rows.get(row.id)?.status).toBe("sent");
  });

  test("invalid recipients fail visibly and can be retried by an internal user", async () => {
    const store = new MemoryReviewNotificationStore();
    const row = ledger();
    store.seed(row, context(row));
    const sender = service(store, async () => ({ sent: false, retryable: false, code: "recipient_invalid" }));

    expect(await sender.deliverDue(10, "https://app.example.test")).toMatchObject({ failed: 1 });
    expect(store.rows.get(row.id)).toMatchObject({ status: "failed", failureCode: "recipient_invalid" });
    expect(await sender.retry(row.reviewRoundId, row.id)).toEqual({ retrying: true });
    expect(store.rows.get(row.id)).toMatchObject({ status: "pending", attemptCount: 0, failureCode: null });
  });
});
