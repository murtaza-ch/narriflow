import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { runSelectionFinalizationFixture } from "../../../apps/api/scripts/gates/selection-hyperdrive-gate";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
dbDescribe("Fixed deployed selection finalization fixture", () => {
  let database: PrismaClient;
  beforeAll(async () => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2 }, { schema }), transactionOptions: { maxWait: 10000, timeout: 30000 } });
  });
  afterAll(async () => { await database.$disconnect(); });
  test("requires an isolated closed gate marker and then finalizes thirty Clips from six three-hour windows and removes the entire fixture", async () => {
    const before = await database.user.count();
    const dispatchesBefore = await database.executionDispatch.count();
    await expect(runSelectionFinalizationFixture(database)).rejects.toThrow("closed_isolated_platform_branch");
    await database.$executeRawUnsafe('CREATE TABLE "_narriflow_platform_lock_gate" (id UUID PRIMARY KEY, value INTEGER NOT NULL)');
    const result = await runSelectionFinalizationFixture(database);
    expect(result).toMatchObject({ passed: true, sourceSeconds: 10800, words: 28800, windowCount: 6, clips: 30, renders: 30, renderRuns: 1, terminalEvents: 1, parentUnleased: true, providerRequests: 0 });
    expect(result.finalizeMs).toBeLessThan(120000);
    expect(result.authorityTransactionMs).toHaveLength(2);
    expect(await database.user.count()).toBe(before);
    expect(await database.executionDispatch.count()).toBe(dispatchesBefore);
  });
});
