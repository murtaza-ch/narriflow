import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { getPrismaClient, createDatabaseScope } from "@narriflow/db/client";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { createApiWorker } from "./worker";
import type { ApiWorkerBindings } from "./worker-bindings";
import { createExecutionRoutes } from "./domains/execution/routes";

const bindings = (key: string) => ({ HYPERDRIVE: { connectionString: key }, OPENAI_API_KEY: key }) as unknown as ApiWorkerBindings;
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

test("static liveness needs neither configuration nor a database", async () => {
  const worker = createApiWorker({ createApp: () => { throw new Error("Liveness must not construct the runtime"); } });
  const response = await worker.fetch(new Request("https://api.test/api/health"), {} as ApiWorkerBindings, context);
  expect(await response.json()).toMatchObject({ ok: true, service: "narriflow-api" });
  expect(getPrismaClient()).toBeNull();
});

test("fenced restore reports its deployed version without runtime work and blocks every callback", async () => {
  let constructed = 0;
  const worker = createApiWorker({ createApp: () => { constructed++; throw Error("Fenced runtime must stay closed"); },
    createScope: () => { constructed++; throw Error("Fenced database must stay closed"); } });
  const fenced = { ADMISSION_STATE: "fenced", CF_VERSION_METADATA: { id: "fenced-version" } } as ApiWorkerBindings;
  const response = await worker.fetch(new Request("https://api.test/api/health"), fenced, context);
  expect(await response.json()).toEqual({ ok: true, service: "narriflow-api", version: "fenced-version", admissionState: "fenced" });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  for (const [method, path] of [["GET", "/api/ready"], ["POST", "/api/execution/command"], ["POST", "/api/execution/transfer"],
    ["POST", "/api/webhooks/stripe"], ["POST", "/api/webhooks/elevenlabs"], ["POST", "/api/dev-device/reconcile"],
    ["GET", "/api/progress/00000000-0000-4000-8000-000000000000"], ["POST", "/api/ingest/link"]]) {
    expect((await worker.fetch(new Request(`https://api.test${path}`, { method }), fenced, context)).status).toBe(503);
  }
  expect(constructed).toBe(0);
});

test("closed cutover admission refuses requests before runtime or database construction", async () => {
  const worker = createApiWorker({ createApp: () => { throw new Error("Closed admission must not construct the runtime"); } });
  const closed = { ADMISSION_STATE: "closed" } as ApiWorkerBindings;
  const response = await worker.fetch(new Request("https://api.test/api/ingest/link", { method: "POST" }), closed, context);
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("5");
  expect((await worker.fetch(new Request("https://api.test/api/health"), closed, context)).status).toBe(200);
});

test("a closed Worker lets the browser read its typed refusal without constructing the runtime", async () => {
  const web = "https://web.test";
  let constructed = 0;
  const worker = createApiWorker({
    createApp: () => { constructed++; throw Error("Closed runtime must stay unavailable"); },
    createScope: () => { constructed++; throw Error("Closed database must stay unavailable"); },
  });
  const closed = { ADMISSION_STATE: "closed", CORS_ALLOWED_ORIGINS: web } as unknown as ApiWorkerBindings;
  const preflight = await worker.fetch(new Request("https://api.test/api/session/bootstrap", {
    method: "OPTIONS",
    headers: { Origin: web, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,x-workspace-id" },
  }), closed, context);
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(web);
  expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  expect(preflight.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("authorization");
  const response = await worker.fetch(new Request("https://api.test/api/session/bootstrap", {
    method: "POST", headers: { Origin: web },
  }), closed, context);
  expect(response.status).toBe(503);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(web);
  expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
  expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  expect(await response.json()).toMatchObject({ error: "server_draining" });
  expect(constructed).toBe(0);
});

test("closed preflight stays scoped to exact first-party origins and fenced mode stays health-only", async () => {
  const worker = createApiWorker({ createApp: () => { throw Error("No refused request may construct a runtime"); } });
  const web = "https://web.test";
  const closed = { ADMISSION_STATE: "closed", CORS_ALLOWED_ORIGINS: web } as unknown as ApiWorkerBindings;
  for (const [origin, path, settings] of [
    ["https://web.test.evil.test", "/api/session/bootstrap", closed],
    [web, "/api/v1/projects", closed],
    [web, "/mcp", closed],
    [web, "/api/webhooks/example", closed],
    [web, "/api/session/bootstrap", { ...closed, ADMISSION_STATE: "fenced" }],
    [web, "/api/session/bootstrap", { ...closed, CORS_ALLOWED_ORIGINS: "https://*.test", WEB_ORIGIN: web }],
  ] as const) {
    const response = await worker.fetch(new Request(`https://api.test${path}`, {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    }), settings as ApiWorkerBindings, context);
    expect(response.status).toBe(503);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  }
  const fallback = await worker.fetch(new Request("https://api.test/api/session/bootstrap", {
    method: "OPTIONS", headers: { Origin: web, "Access-Control-Request-Method": "POST" },
  }), { ADMISSION_STATE: "closed", WEB_ORIGIN: web } as unknown as ApiWorkerBindings, context);
  expect(fallback.status).toBe(204);
  expect(fallback.headers.get("Access-Control-Allow-Origin")).toBe(web);
});

test("paused intake keeps accepted signed control and provider callbacks reachable without changing their bytes", async () => {
  const worker = createApiWorker({ createApp: () => new Hono().post("*", async c => c.text(await c.req.text())) });
  const closed = { ...bindings("postgresql://unused.test/db"), ADMISSION_STATE: "closed" } as ApiWorkerBindings;
  for (const path of ["/api/execution/command", "/api/execution/transfer", "/api/webhooks/elevenlabs", "/api/webhooks/stripe", "/api/dev-device/execution/command"]) {
    const raw = '{ "signed" : true }\n';
    const response = await worker.fetch(new Request(`https://api.test${path}`, { method: "POST", body: raw }), closed, context);
    expect(response.status).toBe(200); expect(await response.text()).toBe(raw);
  }
  expect((await worker.fetch(new Request("https://api.test/api/execution/arbitrary", { method: "POST" }), closed,context)).status).toBe(503);
  expect(getPrismaClient()).toBeNull();
});

test("the paused continuation exception still rejects unsigned execution before constructing database work", async () => {
  const unreachable = async (): Promise<never> => { throw Error("Unsigned work must not execute"); };
  const worker = createApiWorker({ createApp: () => new Hono().route("/api",createExecutionRoutes({ keyRing: () => new Map(), nowSeconds: () => 0, execute: unreachable, transfer: unreachable })),
    createScope: () => createDatabaseScope({ createClient: () => { throw Error("Unsigned work must not construct a client"); } }) });
  const response = await worker.fetch(new Request("https://api.test/api/execution/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
    { ...bindings("unused"), ADMISSION_STATE: "closed" } as ApiWorkerBindings, context);
  expect(response.status).toBe(401); expect((await response.json()).error).toBe("execution_signature_invalid");
});

test("a DO-only invocation with no committed notification keeps the database resource lazy", async () => {
  let clients = 0;
  const worker = createApiWorker({
    createScope: () => createDatabaseScope({ createClient: () => { clients++; throw new Error("DO-only traffic must not construct Prisma"); } }),
    createApp: () => new Hono().get("/device-presence", c => c.json({ available: false })),
  });
  expect((await worker.fetch(new Request("https://api.test/device-presence"), bindings("unused"), context)).status).toBe(200);
  expect(clients).toBe(0);
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

test("a crash while building or running the app is logged and answered as a generic JSON 500 with a request ID", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const web = "https://web.test";
    const worker = createApiWorker({ createApp: () => { throw new Error("config exploded", { cause: Object.assign(new Error("db down"), { code: "ECONNREFUSED" }) }); } });
    const response = await worker.fetch(new Request("https://api.test/api/session/bootstrap", { method: "POST", headers: { Origin: web } }),
      { ...bindings("unused"), CORS_ALLOWED_ORIGINS: web } as unknown as ApiWorkerBindings, context);
    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(web);
    const body = await response.json();
    expect(body).toMatchObject({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("exploded");
    expect(response.headers.get("X-Request-ID")).toBe(body.requestId);
    const line = warn.mock.calls.map(([text]) => JSON.parse(String(text))).find((entry) => entry.message === "worker_unhandled_failure");
    expect(line).toMatchObject({ requestId: body.requestId, error: { message: "config exploded", causes: [{ code: "ECONNREFUSED" }] } });
  } finally { warn.mockRestore(); }
});
