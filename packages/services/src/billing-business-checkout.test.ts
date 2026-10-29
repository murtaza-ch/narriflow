import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BillingError, BillingService } from "./billing.service";
import { isExpectedDomainFailure, type ExpectedDomainFailure } from "./expected-domain-failure";
import { workspaceService } from "./workspace.service";
import { workspaceCommands } from "./workspace-commands-runtime";

const KEY = "018f5f6a-4c31-7c75-9a4f-8f74f977bc20";
const RETURN = "https://app.narriflow.test/settings/billing";
const env = ["STRIPE_SECRET_KEY", "STRIPE_PRICE_BUSINESS_ANNUAL", "STRIPE_PRICE_BUSINESS_MONTHLY"] as const;

let saved: Record<string, string | undefined>;
let service: BillingService;
let checkouts: Array<Record<string, unknown>>;
let created: string[];
const creation = { clientIdempotencyKey: "intent-1" };

function stubWorkspaces(actor: { role: string; status: string; workspaceName: string } | null = null) {
  // Stands in for the receipt-backed command: one Workspace per caller key, replays after.
  const byKey = new Map<string, { workspaceId: string; name: string }>();
  spyOn(workspaceCommands, "createBusinessWorkspace").mockImplementation((async (
    _userId: string,
    input: { name: string },
    mutation: { clientIdempotencyKey: string },
  ) => {
    const known = byKey.get(mutation.clientIdempotencyKey);
    if (known) return { ...known, replayed: true };
    created.push(input.name);
    const workspace = { workspaceId: `ws-pending-${created.length}`, name: input.name };
    byKey.set(mutation.clientIdempotencyKey, workspace);
    return { ...workspace, replayed: false };
  }) as never);
  spyOn(workspaceService, "requireActor").mockImplementation((async () => actor) as never);
}

function stubCheckout(behaviour: () => Promise<{ url: string }> = async () => ({ url: "https://checkout.stripe.test/b/1" })) {
  spyOn(service, "startCheckout").mockImplementation(((input: Record<string, unknown>) => {
    checkouts.push(input);
    return behaviour();
  }) as never);
}

async function failureOf(promise: Promise<unknown>): Promise<ExpectedDomainFailure> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!isExpectedDomainFailure(error)) throw new Error(`expected a domain failure, got ${String(error)}`);
  return error;
}

beforeEach(() => {
  saved = Object.fromEntries(env.map((name) => [name, process.env[name]]));
  process.env.STRIPE_SECRET_KEY = "sk_test_unused";
  process.env.STRIPE_PRICE_BUSINESS_ANNUAL = "price_business_annual";
  process.env.STRIPE_PRICE_BUSINESS_MONTHLY = "price_business_monthly";
  service = new BillingService();
  checkouts = [];
  created = [];
});

afterEach(() => {
  for (const name of env) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  (workspaceCommands.createBusinessWorkspace as { mockRestore?: () => void }).mockRestore?.();
  (workspaceService.requireActor as { mockRestore?: () => void }).mockRestore?.();
});

describe("Business Workspace checkout", () => {
  test("creates the pending Workspace once and starts Business Checkout against it", async () => {
    stubWorkspaces();
    stubCheckout();
    const result = await service.startBusinessWorkspaceCheckout({
      actorUserId: "user-1",
      name: "Acme",
      creation,
      interval: "annual",
      checkoutIdempotencyKey: KEY,
      returnDestination: RETURN,
    });
    expect(result).toEqual({
      workspaceId: "ws-pending-1",
      workspaceName: "Acme",
      interval: "annual",
      checkoutIdempotencyKey: KEY,
      checkoutUrl: "https://checkout.stripe.test/b/1",
    });
    expect(created).toEqual(["Acme"]);
    expect(checkouts).toEqual([
      {
        userId: "user-1",
        workspaceId: "ws-pending-1",
        clientIdempotencyKey: KEY,
        tier: "business",
        interval: "annual",
        returnDestination: RETURN,
      },
    ]);
  });

  test("a retried submit after a lost response resumes the same pending Workspace and Checkout key", async () => {
    stubWorkspaces();
    stubCheckout();
    const submit = () =>
      service.startBusinessWorkspaceCheckout({
        actorUserId: "user-1",
        name: "Acme",
        creation,
        interval: "annual",
        returnDestination: RETURN,
      });
    const first = await submit();
    const retry = await submit();
    expect(created).toEqual(["Acme"]);
    expect(retry.workspaceId).toBe(first.workspaceId);
    expect(retry.checkoutIdempotencyKey).toBe(first.checkoutIdempotencyKey);
    expect(checkouts.map((checkout) => checkout.workspaceId)).toEqual([first.workspaceId, first.workspaceId]);
    expect(checkouts[1]?.clientIdempotencyKey).toBe(checkouts[0]?.clientIdempotencyKey);
    // Another intent is another Workspace.
    const other = await service.startBusinessWorkspaceCheckout({
      actorUserId: "user-1",
      name: "Acme",
      creation: { clientIdempotencyKey: "intent-2" },
      interval: "annual",
      returnDestination: RETURN,
    });
    expect(other.workspaceId).not.toBe(first.workspaceId);
    expect(created).toEqual(["Acme", "Acme"]);
  });

  test("mints the Checkout key when the caller sent none, and returns it for the retry", async () => {
    stubWorkspaces();
    stubCheckout();
    const result = await service.startBusinessWorkspaceCheckout({
      actorUserId: "user-1",
      name: "Acme",
      creation,
      interval: "monthly",
      returnDestination: RETURN,
    });
    expect(result.checkoutIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(checkouts[0]?.clientIdempotencyKey).toBe(result.checkoutIdempotencyKey);
  });

  test("resumes a Workspace awaiting payment without creating another", async () => {
    stubWorkspaces({ role: "owner", status: "pending_payment", workspaceName: "Stored name" });
    stubCheckout();
    const result = await service.startBusinessWorkspaceCheckout({
      actorUserId: "user-1",
      workspaceId: "ws-pending",
      name: "Edited client-side",
      interval: "annual",
      checkoutIdempotencyKey: KEY,
      returnDestination: RETURN,
    });
    expect(created).toEqual([]);
    expect(result.workspaceName).toBe("Stored name");
    expect(workspaceService.requireActor).toHaveBeenCalledWith("user-1", "ws-pending", "billing.manage");
    expect(checkouts[0]).toMatchObject({ workspaceId: "ws-pending", clientIdempotencyKey: KEY });
  });

  test.each([
    { role: "admin", status: "pending_payment" },
    { role: "owner", status: "active" },
  ])("refuses to resume a Workspace that is not the owner's pending one: $role/$status", async (actor) => {
    stubWorkspaces({ ...actor, workspaceName: "Acme" });
    stubCheckout();
    const failure = await failureOf(
      service.startBusinessWorkspaceCheckout({
        actorUserId: "user-1",
        workspaceId: "ws-other",
        interval: "annual",
        checkoutIdempotencyKey: KEY,
        returnDestination: RETURN,
      }),
    );
    expect(failure.code).toBe("workspace_checkout_state_invalid");
    expect(failure.kind).toBe("conflict");
    expect(checkouts).toEqual([]);
  });

  test("unconfigured checkout fails before any Workspace exists, naming the interval", async () => {
    delete process.env.STRIPE_PRICE_BUSINESS_ANNUAL;
    stubWorkspaces();
    stubCheckout();
    const failure = await failureOf(
      service.startBusinessWorkspaceCheckout({
        actorUserId: "user-1",
        name: "Acme",
        creation,
        interval: "annual",
        checkoutIdempotencyKey: KEY,
        returnDestination: RETURN,
      }),
    );
    expect(failure).toMatchObject({
      code: "checkout_not_configured",
      kind: "unavailable",
      message: "Business annual checkout is temporarily unavailable. Try again later.",
    });
    expect(failure.details).toEqual({ recovery: { workspaceName: "Acme", interval: "annual", checkoutIdempotencyKey: KEY } });
    expect(created).toEqual([]);
  });

  test("a Checkout failure after creation keeps its code and carries the pending Workspace for the retry", async () => {
    stubWorkspaces();
    stubCheckout(async () => {
      throw new BillingError("checkout_in_progress");
    });
    const failure = await failureOf(
      service.startBusinessWorkspaceCheckout({
        actorUserId: "user-1",
        name: "Acme",
        creation,
        interval: "annual",
        checkoutIdempotencyKey: KEY,
        returnDestination: RETURN,
      }),
    );
    expect(failure).toMatchObject({ code: "checkout_in_progress", kind: "conflict" });
    expect(failure.details).toEqual({
      recovery: { workspaceId: "ws-pending-1", workspaceName: "Acme", interval: "annual", checkoutIdempotencyKey: KEY },
    });
  });

  test("an unexpected failure is generic, logged without its message, and still recoverable", async () => {
    stubWorkspaces();
    stubCheckout(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failure = await failureOf(
        service.startBusinessWorkspaceCheckout({
          actorUserId: "user-1",
          name: "Acme",
          creation,
          interval: "annual",
          checkoutIdempotencyKey: KEY,
          returnDestination: RETURN,
        }),
      );
      expect(failure).toMatchObject({
        code: "workspace_checkout_failed",
        kind: "unavailable",
        message: "Workspace checkout could not be started",
      });
      expect(failure.details).toMatchObject({ recovery: { workspaceId: "ws-pending-1", checkoutIdempotencyKey: KEY } });
      expect(JSON.stringify(failure.details)).not.toContain("hunter2");
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("hunter2");
    } finally {
      warn.mockRestore();
    }
  });
});
