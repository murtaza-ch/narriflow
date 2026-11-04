import { expect, spyOn, test } from "bun:test";
import { createDatabaseScope, getPrismaClient, withDatabaseScope } from "./client";

test("a request that does not use the database creates no client", async () => {
  let created = false;
  const scope = createDatabaseScope({
    createClient() {
      created = true;
      throw new Error("Static requests must not create a database client");
    },
  });
  const response = await withDatabaseScope(scope, () => Response.json({ ok: true }));
  expect(response.status).toBe(200);
  expect(created).toBe(false);
  expect(getPrismaClient()).toBeNull();
});

test("overlapping requests retain their own client across awaits and each releases it", async () => {
  const first = { identity: "first" } as unknown as import("@prisma/client").PrismaClient;
  const second = { identity: "second" } as unknown as import("@prisma/client").PrismaClient;
  const released: string[] = [];
  let releaseFirst!: () => void;
  const firstMayResume = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const requestOne = withDatabaseScope(createDatabaseScope({
    createClient: () => ({ client: first, dispose: async () => { released.push("first"); } }),
  }), async () => {
    expect(getPrismaClient()).toBe(first);
    await firstMayResume;
    expect(getPrismaClient()).toBe(first);
  });
  await withDatabaseScope(createDatabaseScope({
    createClient: () => ({ client: second, dispose: async () => { released.push("second"); } }),
  }), async () => {
    await Promise.resolve();
    expect(getPrismaClient()).toBe(second);
  });
  expect(getPrismaClient()).toBeNull();
  expect(released).toEqual(["second"]);
  releaseFirst();
  await requestOne;
  expect(released).toEqual(["second", "first"]);
});

test("failure closes its client and work retained after the handler cannot reuse it", async () => {
  let disposed = false;
  const failure = new Error("request failed");
  let delayedRead!: () => import("@prisma/client").PrismaClient | null;
  const scope = createDatabaseScope({
    createClient: () => ({
      client: {} as import("@prisma/client").PrismaClient,
      dispose: async () => { disposed = true; },
    }),
  });
  await expect(withDatabaseScope(scope, async () => {
    getPrismaClient();
    const { AsyncLocalStorage } = await import("node:async_hooks");
    delayedRead = AsyncLocalStorage.bind(getPrismaClient);
    throw failure;
  })).rejects.toBe(failure);
  expect(disposed).toBe(true);
  expect(delayedRead).toThrow("Database scope is closed");
  await expect(withDatabaseScope(scope, () => undefined)).rejects.toThrow("only run once");
  expect(getPrismaClient()).toBeNull();
});

test("a failing disposal neither replaces a successful result nor hides the original error", async () => {
  const failingScope = () => createDatabaseScope({
    createClient: () => ({ client: {} as unknown as import("@prisma/client").PrismaClient, dispose: async () => { throw new Error("pool already closed"); } }),
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await withDatabaseScope(failingScope(), async () => { getPrismaClient(); return "committed"; })).toBe("committed");
    await expect(withDatabaseScope(failingScope(), async () => { getPrismaClient(); throw new Error("the real failure"); })).rejects.toThrow("the real failure");
    expect(warn.mock.calls.length).toBe(2);
  } finally { warn.mockRestore(); }
});
