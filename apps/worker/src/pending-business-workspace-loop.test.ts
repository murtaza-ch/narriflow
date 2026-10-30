import { expect, test } from "bun:test";
import { createIsolatedPollLoop } from "./poll-loop";

test("pending cleanup is wired outside maintenance and at an hourly cadence", async () => {
  const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  const maintenance = source.slice(source.indexOf('const maintenanceLoop ='), source.indexOf('const uploadSessionMaintenanceLoop ='));
  expect(maintenance).toContain("reapStalledRunsIfDue()");
  expect(maintenance).not.toContain("sweepPendingBusinessWorkspaces");
  expect(source).toContain('createPollLoop("pending_business_workspaces", 60 * 60 * 1000');
});

for (const failure of ["stalled", "failed"] as const) {
  test(`a ${failure} cleanup tick does not block later reaper ticks`, async () => {
    const release = Promise.withResolvers<number>();
    let reaped = 0;
    const sweep = createIsolatedPollLoop({ name: "pending_business_workspaces", stallAfterMs: 60_000, maximumConsecutiveFailures: 3,
      run: async () => { if (failure === "failed") throw new Error("Stripe unavailable"); return release.promise; },
    });
    const maintenance = createIsolatedPollLoop({ name: "maintenance", stallAfterMs: 60_000, maximumConsecutiveFailures: 3,
      run: async () => ++reaped,
    });
    const sweeping = sweep.tick();
    try {
      await maintenance.tick();
      await maintenance.tick();
      expect(reaped).toBe(2);
      if (failure === "stalled") expect(sweep.status().polling).toBe(true);
    } finally {
      release.resolve(0);
      await sweeping;
    }
  });
}
