import { describe, expect, test } from "bun:test";
import { createDeveloperCommands, CredentialAlreadyIssuedError, type DeveloperCommandDependencies } from "./developer-commands";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import {
  createOperationReceiptExecutor,
  OperationIdempotencyConflictError,
  type OperationReceipt,
  type OperationReceiptIdentity,
  type OperationReceiptPersistence,
} from "./operation-receipt";
import { PlanRequirementError } from "./plan-features";

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

const webhookView = (id: string) => ({
  webhookId: id, urlHost: "hooks.example.com", types: ["operation.finished"], status: "active", disabledReason: null,
  disabledAt: null, lastDeliveredSeq: 0, consecutiveFailures: 0, lastAttemptAt: null, lastResponseStatus: null,
  lastDeliveredAt: null, createdAt: "2030-01-01T00:00:00.000Z",
});

function fixture(options: { loseCommitResponse?: boolean; tier?: "free" | "pro"; duplicateUrl?: boolean } = {}) {
  const harness = receiptHarness(options);
  const calls = { keys: 0, secrets: 0, webhooks: 0, prepared: 0, urlChecks: 0 };
  const tier = options.tier ?? "pro";
  const workspaces = {
    requireActor: async (userId: string, workspaceId: string) => ({
      actorUserId: userId, workspaceId, workspaceName: "Team", workspaceOwnerUserId: userId,
      role: "owner" as const, status: "active" as const, pricingTier: tier, isPersonalWorkspace: false,
    }),
    issueApiKey: async (_tx: unknown, _userId: string, _workspaceId: string, normalized: { name: string; scopes: string[] }) => {
      calls.keys += 1;
      return {
        id: `key-${calls.keys}`, name: normalized.name, prefix: `nf_prefix${calls.keys}`, scopes: normalized.scopes,
        createdAt: new Date("2030-01-01T00:00:00.000Z"), secret: `nf_plaintext-secret-${calls.keys}`,
      };
    },
  };
  const signingSecrets = {
    issue: async () => {
      calls.secrets += 1;
      return { id: `secret-${calls.secrets}`, secret: `whsec_plaintext-${calls.secrets}`, createdAt: "2030-01-01T00:00:00.000Z" };
    },
  };
  const webhooks = {
    prepareCreate: (input: { url: URL; types: readonly string[] }) => {
      calls.prepared += 1;
      return { registration: { urlFingerprint: input.url.href }, types: [...input.types] };
    },
    insert: async () => {
      if (options.duplicateUrl) throw Object.assign(new Error("unique"), { code: "P2002" });
      calls.webhooks += 1;
      return webhookView(`hook-${calls.webhooks}`);
    },
    explainInsertFailure: async (_actor: unknown, _prepared: unknown, error: unknown) =>
      (error as { code?: string }).code === "P2002"
        ? new ExpectedDomainFailureError({ code: "webhook_exists", kind: "conflict", message: "exists" })
        : error,
  };
  const commands = createDeveloperCommands({
    receipts: () => harness.executor,
    workspaces,
    signingSecrets,
    webhooks,
    assertCallbackUrl: async (raw: string) => {
      calls.urlChecks += 1;
      if (raw.startsWith("http://")) throw new ExpectedDomainFailureError({ code: "callback_url_invalid", kind: "invalid", message: "https only" });
      return new URL(raw);
    },
  } as unknown as DeveloperCommandDependencies);
  return { commands, calls, receipts: harness.receipts };
}

const actor = { actorUserId: "owner", workspaceId: "workspace-a" };
const mutation = (key: string) => ({ clientIdempotencyKey: key });

describe("create_api_key", () => {
  test("returns the secret to the accepting request and keeps no plaintext in the receipt", async () => {
    const { commands, calls, receipts } = fixture();
    const first = await commands.createApiKey(actor, { name: "n8n" }, mutation("k1"));
    expect(first.secret).toBe("nf_plaintext-secret-1");
    expect(first.key).toMatchObject({ id: "key-1", name: "n8n", createdAt: "2030-01-01T00:00:00.000Z" });
    expect(calls.keys).toBe(1);
    expect(JSON.stringify([...receipts.values()])).not.toContain("plaintext");
  });

  test("a replay is credential_already_issued: it mints nothing and discloses nothing", async () => {
    const { commands, calls } = fixture();
    await commands.createApiKey(actor, { name: "n8n" }, mutation("k1"));
    const replay = await commands.createApiKey(actor, { name: " n8n " }, mutation("k1")).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(CredentialAlreadyIssuedError);
    expect(replay).toMatchObject({ code: "credential_already_issued", kind: "conflict", details: { credential: "api_key", keyId: "key-1" } });
    expect(JSON.stringify(replay)).not.toContain("plaintext");
    expect(calls.keys).toBe(1);
  });

  test("a lost response cannot be recovered by retrying, and issues no second key; a new intent can", async () => {
    const { commands, calls } = fixture({ loseCommitResponse: true });
    // The commit succeeded but the response was lost: even the first caller learns the key exists and cannot be shown.
    const lost = await commands.createApiKey(actor, { name: "n8n" }, mutation("k1")).catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(CredentialAlreadyIssuedError);
    const retry = await commands.createApiKey(actor, { name: "n8n" }, mutation("k1")).catch((error: unknown) => error);
    expect(retry).toBeInstanceOf(CredentialAlreadyIssuedError);
    expect(calls.keys).toBe(1);
    const fresh = await commands.createApiKey(actor, { name: "n8n" }, mutation("k2"));
    expect(fresh.secret).toBe("nf_plaintext-secret-2");
  });

  test("a changed request under the same key conflicts", async () => {
    const { commands, calls } = fixture();
    await commands.createApiKey(actor, { name: "a" }, mutation("k1"));
    await expect(commands.createApiKey(actor, { name: "b" }, mutation("k1"))).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
    expect(calls.keys).toBe(1);
  });

  test("simultaneous requests with one key issue one key", async () => {
    const { commands, calls } = fixture();
    const outcomes = await Promise.all(
      [1, 2, 3].map(() => commands.createApiKey(actor, { name: "a" }, mutation("same")).catch((error: unknown) => error)),
    );
    expect(calls.keys).toBe(1);
    expect(outcomes.filter((outcome) => !(outcome instanceof Error))).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome instanceof CredentialAlreadyIssuedError)).toHaveLength(2);
  });

  test("a plan without API access creates nothing", async () => {
    const { commands, calls } = fixture({ tier: "free" });
    await expect(commands.createApiKey(actor, { name: "a" }, mutation("k1"))).rejects.toBeInstanceOf(PlanRequirementError);
    expect(calls.keys).toBe(0);
  });

  test("the new-mutation limiter runs after the replay lookup", async () => {
    const { commands } = fixture();
    let limited = 0;
    const limiter = { clientIdempotencyKey: "k1", beforeAccept: async () => { limited += 1; } };
    await commands.createApiKey(actor, { name: "a" }, limiter);
    await commands.createApiKey(actor, { name: "a" }, limiter).catch(() => undefined);
    expect(limited).toBe(1);
  });
});

describe("rotate_callback_signing_secret", () => {
  test("returns the secret once; the receipt names the stored secret but holds no plaintext", async () => {
    const { commands, calls, receipts } = fixture();
    const first = await commands.rotateCallbackSigningSecret(actor, mutation("r1"));
    expect(first).toEqual({ createdAt: "2030-01-01T00:00:00.000Z", secret: "whsec_plaintext-1" });
    const replay = await commands.rotateCallbackSigningSecret(actor, mutation("r1")).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(CredentialAlreadyIssuedError);
    expect(replay).toMatchObject({ code: "credential_already_issued", details: { credential: "callback_signing_secret" } });
    expect(calls.secrets).toBe(1);
    expect(JSON.stringify([...receipts.values()])).not.toContain("plaintext");
  });

  test("a deliberate second rotation uses a new key and rotates again", async () => {
    const { commands, calls } = fixture();
    await commands.rotateCallbackSigningSecret(actor, mutation("r1"));
    const second = await commands.rotateCallbackSigningSecret(actor, mutation("r2"));
    expect(second.secret).toBe("whsec_plaintext-2");
    expect(calls.secrets).toBe(2);
  });

  test("a plan without API access rotates nothing", async () => {
    const { commands, calls } = fixture({ tier: "free" });
    await expect(commands.rotateCallbackSigningSecret(actor, mutation("r1"))).rejects.toBeInstanceOf(PlanRequirementError);
    expect(calls.secrets).toBe(0);
  });
});

describe("create_webhook", () => {
  const input = { url: " https://hooks.example.com/x ", types: ["operation.finished"] as const };

  test("registers once; a replay returns the same webhook without preparing or inserting again", async () => {
    const { commands, calls } = fixture();
    const first = await commands.createWebhook(actor, input, mutation("w1"));
    expect(first).toMatchObject({ replayed: false, webhook: { webhookId: "hook-1" } });
    const replay = await commands.createWebhook(actor, input, mutation("w1"));
    expect(replay).toMatchObject({ replayed: true, webhook: { webhookId: "hook-1" } });
    expect(calls).toMatchObject({ webhooks: 1, prepared: 1, urlChecks: 1 });
  });

  test("an unsafe endpoint is refused before anything is written", async () => {
    const { commands, calls } = fixture();
    await expect(commands.createWebhook(actor, { url: "http://hooks.example.com/x", types: ["operation.finished"] }, mutation("w1"))).rejects.toMatchObject({
      code: "callback_url_invalid",
    });
    expect(calls.webhooks).toBe(0);
  });

  test("a second webhook for the same URL becomes webhook_exists", async () => {
    const { commands } = fixture({ duplicateUrl: true });
    await expect(commands.createWebhook(actor, input, mutation("w1"))).rejects.toMatchObject({ code: "webhook_exists" });
  });

  test("a plan without API access registers nothing", async () => {
    const { commands, calls } = fixture({ tier: "free" });
    await expect(commands.createWebhook(actor, input, mutation("w1"))).rejects.toBeInstanceOf(PlanRequirementError);
    expect(calls).toMatchObject({ webhooks: 0, urlChecks: 0 });
  });
});
