import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { ExecutionRestoreService } from "./execution-restore";
import { ExecutionMaintenanceService, HOURLY_MAINTENANCE_PHASES } from "./execution-maintenance";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Execution restore authority", () => {
  let database: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
  });
  afterAll(async () => { await database?.$disconnect(); });
  test("begin closes and advances the epoch once, fencing an old command before registering recovery; a lost ACK resumes the same restore", async () => {
    const epoch = (await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const maintenance = new ExecutionMaintenanceService({ database, register: async () => {},
      phases: Object.fromEntries(HOURLY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])) });
    const old = await maintenance.start({ cadence: "hourly", scheduledAt: new Date("2026-10-31T10:00:00.000Z") });
    let loseAcknowledgement = true;
    const registered: string[][] = [];
    const restore = new ExecutionRestoreService({ database, register: async ids => {
      expect(await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ epoch: epoch + 1, admissionOpen: false });
      expect(await maintenance.run(old)).toMatchObject({ kind: "superseded" });
      registered.push([...ids]);
      if (loseAcknowledgement) throw new Error("Lost restore acknowledgement");
    } });
    await expect(restore.begin({ expectedEpoch: epoch })).rejects.toThrow("Lost restore acknowledgement");
    loseAcknowledgement = false;
    const recovered = await restore.begin({ expectedEpoch: epoch });
    expect(recovered).toMatchObject({ previousEpoch: epoch, deploymentEpoch: epoch + 1 });
    expect(registered[1]).toEqual(registered[0]);
    expect(await database.executionDispatch.count({ where: { deploymentEpoch: epoch + 1, subjectId: { startsWith: "rs1." } } })).toBe(1);
    await expect(restore.begin({ expectedEpoch: epoch + 2 })).rejects.toMatchObject({ code: "restore_epoch_changed" });
    expect((await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).admissionOpen).toBe(false);
  });
});
