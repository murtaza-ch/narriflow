import { describe, expect, test } from "bun:test";
import {
  createOperationReceiptExecutor,
  OperationIdempotencyConflictError,
  type OperationReceipt,
  type OperationReceiptIdentity,
  type OperationReceiptPersistence,
} from "./operation-receipt";
import { createWorkspaceCommands, type WorkspaceCommandDependencies } from "./workspace-commands";

type Tx = { id: number };

/** In-memory receipts with a serialized transaction, so concurrent callers meet the same lock as PostgreSQL's. */
function receiptHarness(options: { loseCommitResponse?: boolean } = {}) {
  const receipts = new Map<string, OperationReceipt>();
  let tail = Promise.resolve();
  let transactions = 0;
  let losses = options.loseCommitResponse ? 1 : 0;
  const key = (identity: OperationReceiptIdentity) =>
    JSON.stringify([identity.workspaceId, identity.actorUserId, identity.command, identity.clientIdempotencyKey]);
  const persistence: OperationReceiptPersistence<Tx> = {
    read: async (identity) => receipts.get(key(identity)) ?? null,
    transaction: async (run) => {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await previous;
      try {
        const result = await run({ id: ++transactions });
        if (losses > 0) {
          losses -= 1;
          throw new Error("Commit response lost");
        }
        return result;
      } finally {
        unlock();
      }
    },
    lock: async () => {},
    readInTransaction: async (_tx, identity) => receipts.get(key(identity)) ?? null,
    create: async (_tx, receipt) => {
      receipts.set(key(receipt), receipt);
    },
  };
  return { executor: createOperationReceiptExecutor(persistence), receipts };
}

function fixture(options: { loseCommitResponse?: boolean } = {}) {
  const harness = receiptHarness(options);
  const calls = { issued: 0, created: 0, entitlement: 0 };
  const workspaces = {
    requireActor: async (userId: string, workspaceId: string) => {
      calls.entitlement += 1;
      return {
        actorUserId: userId, workspaceId, workspaceName: "Team", workspaceOwnerUserId: userId,
        role: "owner" as const, status: "active" as const, pricingTier: "business" as const, isPersonalWorkspace: false,
      };
    },
    getPersonalWorkspaceId: async (_userId: string) => "personal-workspace",
    createPendingBusinessWorkspace: async (_userId: string, input: { name: string }) => {
      calls.created += 1;
      return { id: `workspace-${calls.created}`, name: input.name, status: "pending_payment", pricingTier: "free" };
    },
    issueInvite: async (_tx: unknown, _userId: string, _workspaceId: string, input: { email: string; role: string }) => {
      calls.issued += 1;
      return {
        id: `invite-${calls.issued}`, email: input.email, role: input.role,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"), token: `raw-token-${calls.issued}`,
      };
    },
    readResendableInvite: async () => ({ email: "a@example.com", role: "editor" as const }),
  };
  const commands = createWorkspaceCommands({
    receipts: () => harness.executor,
    workspaces,
  } as unknown as WorkspaceCommandDependencies);
  return { commands, calls, receipts: harness.receipts };
}

const actor = { actorUserId: "owner", workspaceId: "workspace-a" };
const mutation = (key: string) => ({ clientIdempotencyKey: key });

describe("workspace invite commands", () => {
  test("returns the one-time token only to the accepting request", async () => {
    const { commands, calls, receipts } = fixture();
    const first = await commands.inviteMember(actor, { email: " New@Example.com ", role: "editor" }, mutation("k1"));
    expect(first.token).toBe("raw-token-1");
    expect(first.replayed).toBe(false);
    expect(first.invite.email).toBe("new@example.com");

    const replay = await commands.inviteMember(actor, { email: "new@example.com", role: "editor" }, mutation("k1"));
    expect(replay.replayed).toBe(true);
    expect(replay.token).toBeNull();
    expect(replay.invite).toEqual(first.invite);
    expect(calls.issued).toBe(1);
    // A receipt is durable; the raw token must never be in it.
    expect(JSON.stringify([...receipts.values()])).not.toContain("raw-token");
  });

  test("a changed input under the same key conflicts instead of inviting someone else", async () => {
    const { commands, calls } = fixture();
    await commands.inviteMember(actor, { email: "a@example.com", role: "editor" }, mutation("k1"));
    await expect(
      commands.inviteMember(actor, { email: "b@example.com", role: "editor" }, mutation("k1")),
    ).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
    expect(calls.issued).toBe(1);
  });

  test("simultaneous requests with one key issue one invite", async () => {
    const { commands, calls } = fixture();
    const outcomes = await Promise.all(
      [1, 2, 3].map(() => commands.inviteMember(actor, { email: "a@example.com", role: "viewer" }, mutation("same"))),
    );
    expect(calls.issued).toBe(1);
    expect(new Set(outcomes.map((outcome) => outcome.invite.id)).size).toBe(1);
    expect(outcomes.filter((outcome) => outcome.token !== null)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.replayed)).toHaveLength(2);
  });

  test("a lost commit response resolves to the accepted invite without a second one or a token", async () => {
    const { commands, calls } = fixture({ loseCommitResponse: true });
    const resolved = await commands.inviteMember(actor, { email: "a@example.com", role: "editor" }, mutation("k1"));
    expect(resolved.replayed).toBe(true);
    expect(resolved.token).toBeNull();
    expect(calls.issued).toBe(1);
  });

  test("replay skips the new-mutation limiter but still reauthorizes", async () => {
    const { commands, calls } = fixture();
    let limited = 0;
    const guarded = { clientIdempotencyKey: "k1", beforeAccept: async () => { limited += 1; } };
    await commands.inviteMember(actor, { email: "a@example.com", role: "editor" }, guarded);
    const authorizations = calls.entitlement;
    await commands.inviteMember(actor, { email: "a@example.com", role: "editor" }, guarded);
    expect(limited).toBe(1);
    expect(calls.entitlement).toBeGreaterThan(authorizations);
  });

  test("resend is its own command and replays by key", async () => {
    const { commands, calls } = fixture();
    const first = await commands.resendInvite(actor, "invite-old", mutation("r1"));
    const replay = await commands.resendInvite(actor, "invite-old", mutation("r1"));
    expect(replay.invite.id).toBe(first.invite.id);
    expect(calls.issued).toBe(1);
    // Same key, different command: not a replay of the invite command.
    const invited = await commands.inviteMember(actor, { email: "a@example.com", role: "editor" }, mutation("r1"));
    expect(invited.replayed).toBe(false);
  });
});

describe("business workspace creation command", () => {
  test("creates one pending Workspace per key and replays the same one", async () => {
    const { commands, calls } = fixture();
    const [first, second] = await Promise.all([
      commands.createBusinessWorkspace("owner", { name: "  Acme   Studio " }, mutation("w1")),
      commands.createBusinessWorkspace("owner", { name: "Acme Studio" }, mutation("w1")),
    ]);
    expect(calls.created).toBe(1);
    expect(first.workspaceId).toBe(second.workspaceId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.name).toBe("Acme Studio");
  });

  test("a new key creates a second Workspace", async () => {
    const { commands, calls } = fixture();
    await commands.createBusinessWorkspace("owner", { name: "One" }, mutation("w1"));
    await commands.createBusinessWorkspace("owner", { name: "One" }, mutation("w2"));
    expect(calls.created).toBe(2);
  });
});
