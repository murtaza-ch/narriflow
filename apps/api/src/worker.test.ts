import { expect, test } from "bun:test";
import { Hono } from "hono";
import { getPrismaClient, createDatabaseScope } from "@narriflow/db/client";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { createApiWorker } from "./worker";
import type { ApiWorkerBindings } from "./worker-bindings";

const bindings = (key: string) => ({ HYPERDRIVE: { connectionString: key }, OPENAI_API_KEY: key }) as unknown as ApiWorkerBindings;
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

test("static liveness needs neither configuration nor a database", async () => {
  const worker = createApiWorker({ createApp: () => { throw new Error("Liveness must not construct the runtime"); } });
  const response = await worker.fetch(new Request("https://api.test/api/health"), {} as ApiWorkerBindings, context);
  expect(await response.json()).toMatchObject({ ok: true, service: "narriflow-api" });
  expect(getPrismaClient()).toBeNull();
});

test("overlapping requests use only their own settings and database scope", async () => {
  let resumeFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { resumeFirst = resolve; });
  const closed: string[] = [];
  const worker = createApiWorker({
    createScope: (key) => createDatabaseScope({ createClient: () => ({ client: { key } as unknown as NonNullable<ReturnType<typeof getPrismaClient>>, dispose: async () => { closed.push(key); } }) }),
    createApp: () => new Hono().get("/settings", async (c) => {
      const before = getPrismaClient();
      if (readServiceEnvironment().OPENAI_API_KEY === "first") await firstMayFinish;
      const key = readServiceEnvironment().OPENAI_API_KEY;
      expect(getPrismaClient()).toBe(before);
      return c.json({ key });
    }),
  });
  const first = worker.fetch(new Request("https://api.test/settings"), bindings("first"), context);
  const second = await worker.fetch(new Request("https://api.test/settings"), bindings("second"), context);
  expect(await second.json()).toEqual({ key: "second" });
  expect(closed).toEqual(["second"]);
  resumeFirst();
  expect(await (await first).json()).toEqual({ key: "first" });
  expect(closed).toEqual(["second", "first"]);
  expect(readServiceEnvironment).toThrow("unavailable");
  expect(getPrismaClient()).toBeNull();
});

test("the original signed webhook bytes reach Hono without reserialization", async () => {
  const bytes = '{ "event" : "example", "value": "\\u0061" }\n';
  const worker = createApiWorker({
    createApp: () => new Hono().post("/api/webhooks/example", async (c) => c.text(await c.req.text())),
  });
  const request = new Request("https://api.test/api/webhooks/example", { method: "POST", headers: { "content-type": "application/json", "webhook-signature": "fixture-signature" }, body: bytes });
  const response = await worker.fetch(request, bindings("postgresql://unused.test/db"), context);
  expect(await response.text()).toBe(bytes);
  expect(getPrismaClient()).toBeNull();
});
