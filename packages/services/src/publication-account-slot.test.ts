import { describe, expect, mock, test } from "bun:test";
import { wakeNextAccountPosts } from "./publication-dispatch";
import { releaseCurrentClaim } from "./social-publication-attempt";

const NOW = new Date("2026-11-06T12:00:40.000Z");
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const HOLDER = "00000000-0000-4000-8000-000000000002";
const CLAIM = "00000000-0000-4000-8000-000000000003";

/** A post due now. `scheduledFor` carries seconds, so it keeps its exact time. */
const due = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, nextAttemptAt: null, scheduledFor: new Date("2026-11-06T11:59:30.000Z"), createdAt: new Date("2026-11-06T11:59:00.000Z"), ...overrides,
});

function setup(options: { slot?: string | null; posts?: ReturnType<typeof due>[] } = {}) {
  const slot = options.slot === undefined ? ACCOUNT : options.slot;
  const findMany = mock(async (_query: unknown) => options.posts ?? [due("first"), due("second"), due("third")]);
  const findUnique = mock(async () => ({ accountSlotKey: slot, attempt: { socialPostId: HOLDER } }));
  const tx = {
    publicationClaim: { findUnique, updateMany: mock(async () => ({ count: 1 })) },
    socialPublicationAttempt: { updateMany: mock(async () => ({ count: 1 })) },
    executionEpoch: { findUniqueOrThrow: async () => ({ epoch: 7 }) },
    socialPost: { findMany },
  };
  const append = mock(async (_tx: unknown, id: string, _options: unknown) => `dispatch-${id}`);
  return { tx, findMany, findUnique, append, wake: () => wakeNextAccountPosts(tx as never, CLAIM, NOW, append as never) };
}
const woken = (append: ReturnType<typeof setup>["append"]) => append.mock.calls.map((call) => call[1]);

describe("account slot release", () => {
  test("wakes the two oldest posts now, so one that cannot claim does not stall the queue", async () => {
    const { append, wake } = setup();
    expect(await wake()).toEqual(["dispatch-first", "dispatch-second"]);
    expect(woken(append)).toEqual(["first", "second"]);
    const { dueAt, wakeKind } = append.mock.calls[0]![2] as { dueAt: Date; wakeKind: string };
    expect(dueAt).toEqual(NOW);
    expect(wakeKind).toMatch(/^pub_[a-f0-9]{32}$/);
  });

  test("looks only at this account's due posts in order, and never at the holder, an older epoch or a paused grant", async () => {
    const { findMany, wake } = setup();
    await wake();
    const query = findMany.mock.calls[0]![0] as { where: Record<string, unknown>; orderBy: unknown };
    expect(query.where).toMatchObject({ socialAccountId: ACCOUNT, id: { not: HOLDER }, status: "scheduled", deploymentEpoch: 7 });
    expect(query.where.AND).toEqual([
      { OR: [{ nextAttemptAt: { lte: NOW } }, { nextAttemptAt: null, scheduledFor: { lte: NOW } }] },
      { OR: [{ standingGrantId: null }, { standingGrant: { status: { not: "paused" } } }] },
    ]);
    expect(query.orderBy).toEqual([{ scheduledFor: "asc" }, { createdAt: "asc" }, { id: "asc" }]);
  });

  test("skips a post still inside its schedule spread and wakes one that can run", async () => {
    const onTheMinute = new Date("2026-11-06T12:00:00.000Z");
    const withOffset = (id: string) => due(id, { scheduledFor: onTheMinute });
    // Whole-minute posts release up to 120s late, by a stable per-post offset.
    const { spreadScheduledPublish } = await import("./publication-dispatch");
    const ids = Array.from({ length: 64 }, (_, n) => `post-${n}`);
    const sleeping = ids.find((id) => spreadScheduledPublish(id, onTheMinute) > NOW)!;
    const runnable = ids.find((id) => spreadScheduledPublish(id, onTheMinute) <= NOW)!;
    const { append, wake } = setup({ posts: [withOffset(sleeping), withOffset(runnable)] });
    await wake();
    expect(woken(append)).toEqual([runnable]);
  });

  test("a post due on its own retry time counts, and one backing off does not", async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const { append, wake } = setup({ posts: [due("backing-off", { nextAttemptAt: later }), due("retry-due", { nextAttemptAt: NOW })] });
    await wake();
    expect(woken(append)).toEqual(["retry-due"]);
  });

  test("a claim that held no slot wakes nobody", async () => {
    const { findMany, append, wake } = setup({ slot: null });
    expect(await wake()).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  test("an empty queue wakes nobody", async () => {
    const { append, wake } = setup({ posts: [] });
    expect(await wake()).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });
});

describe("releasing a claim", () => {
  const owned = { attemptId: "attempt", claimId: CLAIM };

  test("a retry keeps the waiters on their timers while the account backs off", async () => {
    const { tx, findUnique } = setup();
    await releaseCurrentClaim(tx as never, owned, NOW, { backingOff: true });
    expect(findUnique).not.toHaveBeenCalled();
    expect(tx.publicationClaim.updateMany).toHaveBeenCalledTimes(1);
  });

  test("any other release looks for the next post before clearing the slot", async () => {
    const { tx, findUnique } = setup({ slot: null });
    await releaseCurrentClaim(tx as never, owned, NOW);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(tx.publicationClaim.updateMany).toHaveBeenCalledTimes(1);
  });
});
