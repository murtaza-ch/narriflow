import { expect, test } from "bun:test";
import { createDatabaseScope, getPrismaClient } from "@narriflow/db/client";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import type { ApiWorkerBindings } from "../worker-bindings";
import { createMaintenanceScheduledHandler } from "./maintenance-scheduled";

const context = { waitUntil() { throw Error("Registration must be awaited"); } } as unknown as ExecutionContext;
const event = (cron: string, scheduledTime = Date.parse("2026-10-31T02:00:00.000Z")) => ({ cron, scheduledTime }) as ScheduledController;

test("fenced Cron delivery stops before settings, runtime or database access", async () => {
  const scheduled = createMaintenanceScheduledHandler({
    createRuntime: async () => { throw Error("Fenced runtime must not be constructed"); },
    createScope: () => { throw Error("Fenced database must not be constructed"); },
  });
  const bindings = new Proxy({ ADMISSION_STATE: "fenced" }, { get(target, key) {
    if (key === "ADMISSION_STATE") return target.ADMISSION_STATE;
    throw Error(`Fenced binding read: ${String(key)}`);
  } }) as unknown as ApiWorkerBindings;
  await scheduled(event("0 * * * *"), bindings, context);
  expect(getPrismaClient()).toBeNull();
});

test("hourly and daily Cron delivery use their original UTC time, invocation settings and a closed database scope", async () => {
  const closed: string[] = [];
  const observed: { cadence: string; scheduledAt: string; admissionState: string; key: string }[] = [];
  let allowRegistration!: () => void;
  const confirmed = new Promise<void>(resolve => { allowRegistration = resolve; });
  const scheduled = createMaintenanceScheduledHandler({
    createScope: key => createDatabaseScope({ createClient: () => ({ client: { key } as unknown as NonNullable<ReturnType<typeof getPrismaClient>>, dispose: async () => { closed.push(key); } }) }),
    createRuntime: async () => ({ scheduled: async input => {
      const database = getPrismaClient();
      expect(database).not.toBeNull();
      const key = readServiceEnvironment().SYNTHETIC_KEY!;
      observed.push({ ...input, scheduledAt: input.scheduledAt.toISOString(), key });
      if (key === "hourly") await confirmed;
      expect(getPrismaClient()).toBe(database);
    } }),
  });
  const bindings = (key: string) => ({ ADMISSION_STATE: "closed", SYNTHETIC_KEY: key, HYPERDRIVE: { connectionString: key } }) as unknown as ApiWorkerBindings;
  let finished = false;
  const hourly = scheduled(event("0 * * * *"), bindings("hourly"), context).then(() => { finished = true; });
  await scheduled(event("0 0 * * *", Date.parse("2026-10-31T00:00:00.000Z")), bindings("daily"), context);
  expect(finished).toBe(false);
  expect(closed).toEqual(["daily"]);
  allowRegistration();
  await hourly;
  expect(observed).toEqual([
    { cadence: "hourly", scheduledAt: "2026-10-31T02:00:00.000Z", admissionState: "closed", key: "hourly" },
    { cadence: "daily", scheduledAt: "2026-10-31T00:00:00.000Z", admissionState: "closed", key: "daily" },
  ]);
  expect(closed).toEqual(["daily", "hourly"]);
  expect(getPrismaClient()).toBeNull();
  expect(readServiceEnvironment).toThrow("unavailable");
});

test("unconfirmed registration fails the scheduled invocation and still releases its connection", async () => {
  let closed = false;
  const scheduled = createMaintenanceScheduledHandler({
    createScope: () => createDatabaseScope({ createClient: () => ({ client: {} as unknown as NonNullable<ReturnType<typeof getPrismaClient>>, dispose: async () => { closed = true; } }) }),
    createRuntime: async () => ({ scheduled: async () => { getPrismaClient(); throw Error("scheduler_unavailable"); } }),
  });
  await expect(scheduled(event("0 * * * *"), { ADMISSION_STATE: "open", HYPERDRIVE: { connectionString: "synthetic" } } as ApiWorkerBindings, context)).rejects.toThrow("scheduler_unavailable");
  expect(closed).toBe(true);
});

test("an unknown schedule or missing admission configuration cannot start maintenance", async () => {
  let constructions = 0;
  const scheduled = createMaintenanceScheduledHandler({
    createScope: () => { constructions++; throw Error("Unexpected database scope"); },
    createRuntime: async () => { constructions++; throw Error("Unexpected runtime"); },
  });
  await expect(scheduled(event("* * * * *"), { ADMISSION_STATE: "open" } as ApiWorkerBindings, context)).rejects.toThrow("maintenance_schedule_invalid");
  await expect(scheduled(event("0 * * * *"), {} as ApiWorkerBindings, context)).rejects.toThrow("maintenance_admission_configuration_invalid");
  expect(constructions).toBe(0);
});
