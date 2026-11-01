import { createDatabaseTestContext } from "@narriflow/db/testing";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { WorkspaceService } from "./workspace.service";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const enabled = process.env.ALLOW_EXECUTION_CONTROL_DB_TESTS === "1" && Boolean(url);
const suite = enabled ? describe : describe.skip;

suite("Workspace API key fresh authentication", () => {
  const context = createDatabaseTestContext(), service = new WorkspaceService();
  const queries: string[] = [], users: string[] = [];
  let db: PrismaClient, pool: Pool;

  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    pool = new Pool({ connectionString: url, max: 8 });
    // Count driver calls, including BEGIN that Prisma's query events omit.
    // Collect SQL text only; query parameters never enter observations.
    pool.on("connect", client => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = ((statement: unknown, ...args: unknown[]) => {
        queries.push(typeof statement === "string" ? statement : (statement as { text: string }).text);
        return query(statement, ...args);
      }) as typeof client.query;
    });
    db = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    context.client = db;
  });
  afterAll(async () => {
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect(); await pool.end();
  });

  async function fixture(differentCreator = false, stale = false) {
    const user = await db.user.create({ data: { clerkId: `api-key-auth-${randomUUID()}` } }); users.push(user.id);
    const creator = differentCreator ? await db.user.create({ data: { clerkId: `api-key-creator-${randomUUID()}` } }) : user;
    if (differentCreator) users.push(creator.id);
    const workspace = await db.workspace.create({ data: { name: "API key authentication gate", ownerUserId: user.id } });
    const secret = `nf_${randomBytes(32).toString("base64url")}`;
    const key = await db.apiKey.create({ data: { userId: user.id, createdByUserId: creator.id, workspaceId: workspace.id,
      name: "Authentication fixture", prefix: secret.slice(0, 11), hashedSecret: createHash("sha256").update(secret).digest("hex"),
      scopes: ["projects:read"], lastUsedAt: stale ? null : new Date() } });
    return { user, creator, workspace, secret, key };
  }

  for (const differentCreator of [false, true]) for (const stale of [false, true])
    test(`fresh authentication uses ${stale ? 2 : 1} statements for ${differentCreator ? "a distinct" : "the same"} creator and ${stale ? "stale" : "recent"} usage`, context.bind(async () => {
      const f = await fixture(differentCreator, stale);
      queries.length = 0;
      expect(await service.authenticateApiKey(f.secret)).toEqual({ apiKeyId: f.key.id, userId: f.creator.id,
        workspaceId: f.workspace.id, name: f.key.name, scopes: ["projects:read"] });
      const count = queries.length;
      console.warn(JSON.stringify({ level: "info", message: "api_key_auth_statement_count", differentCreator, stale, count,
        operations: queries.map(query => /^[A-Z]+/.exec(query.trim())?.[0]) }));
      expect(count).toBe(stale ? 2 : 1);
    }));

  for (const refused of ["unknown", "malformed", "wrong_hash", "revoked", "no_workspace", "deleted_user", "deleted_creator", "missing_creator"] as const)
    test(`authentication refuses ${refused} without recording usage`, context.bind(async () => {
      const f = await fixture(true, true);
      let secret = f.secret;
      if (refused === "unknown") secret = `nf_${randomBytes(32).toString("base64url")}`;
      if (refused === "malformed") secret = "nf_short";
      if (refused === "wrong_hash") secret = f.secret.slice(0, -1) + (f.secret.endsWith("a") ? "b" : "a");
      if (refused === "revoked") await db.apiKey.update({ where: { id: f.key.id }, data: { revokedAt: new Date() } });
      if (refused === "no_workspace") await db.apiKey.update({ where: { id: f.key.id }, data: { workspaceId: null } });
      if (refused === "deleted_user") await db.user.update({ where: { id: f.user.id }, data: { deletedAt: new Date() } });
      if (refused === "deleted_creator") await db.user.update({ where: { id: f.creator.id }, data: { deletedAt: new Date() } });
      if (refused === "missing_creator") await db.apiKey.update({ where: { id: f.key.id }, data: { createdByUserId: randomUUID() } });
      const before = await db.apiKey.findUniqueOrThrow({ where: { id: f.key.id } });
      queries.length = 0;
      expect(await service.authenticateApiKey(secret)).toBeNull();
      expect(queries.some(query => /^UPDATE\b/.test(query))).toBe(false);
      expect(await db.apiKey.findUniqueOrThrow({ where: { id: f.key.id } })).toEqual(before);
    }));

  test("a nullable creator uses the key user and each new request observes revocation", context.bind(async () => {
    const f = await fixture();
    await db.apiKey.update({ where: { id: f.key.id }, data: { createdByUserId: null } });
    expect((await service.authenticateApiKey(f.secret))?.userId).toBe(f.user.id);
    await db.apiKey.update({ where: { id: f.key.id }, data: { revokedAt: new Date() } });
    expect(await service.authenticateApiKey(f.secret)).toBeNull();
  }));

  for (const offset of [-1, 0, 1])
    test(`usage records only timestamps strictly before the five-minute cutoff (${offset}ms)`, context.bind(async () => {
      const f = await fixture(), fixedNow = Date.now(), previous = new Date(fixedNow - 300_000 + offset);
      await db.apiKey.update({ where: { id: f.key.id }, data: { lastUsedAt: previous, updatedAt: new Date(0) } });
      const clock = spyOn(Date, "now").mockReturnValue(fixedNow);
      try { expect((await service.authenticateApiKey(f.secret))?.apiKeyId).toBe(f.key.id); }
      finally { clock.mockRestore(); }
      const after = await db.apiKey.findUniqueOrThrow({ where: { id: f.key.id } });
      if (offset < 0) {
        expect(after.lastUsedAt!.getTime()).toBeGreaterThan(previous.getTime());
        expect(after.updatedAt.getTime()).toBeGreaterThan(0);
      } else {
        expect(after.lastUsedAt).toEqual(previous);
        expect(after.updatedAt).toEqual(new Date(0));
      }
    }));

  test("usage write failures remain awaited and leave the key untouched", context.bind(async () => {
    const f = await fixture(false, true), schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".api_key_usage_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'api_key_usage_write_refused'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER api_key_usage_refuse BEFORE UPDATE ON "${schema}"."ApiKey" FOR EACH ROW EXECUTE FUNCTION "${schema}".api_key_usage_refuse()`);
    try {
      await expect(service.authenticateApiKey(f.secret)).rejects.toThrow("api_key_usage_write_refused");
      expect(await db.apiKey.findUniqueOrThrow({ where: { id: f.key.id } })).toEqual(f.key);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER api_key_usage_refuse ON "${schema}"."ApiKey"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${schema}".api_key_usage_refuse()`);
    }
  }));

  async function authenticateBehindKeyLock(keyId: string, secret: string, count: number,
    beforeCommit?: (client: PoolClient) => Promise<void>) {
    const blocker = await pool.connect();
    let result: ReturnType<typeof service.authenticateApiKey>[] = [];
    try {
      await blocker.query("BEGIN");
      await blocker.query('SELECT id FROM "ApiKey" WHERE id=$1::uuid FOR UPDATE', [keyId]);
      result = Array.from({ length: count }, () => service.authenticateApiKey(secret));
      const all = Promise.all(result);
      const relation = `"${process.env.SERVERLESS_TEST_DATABASE_SCHEMA}"."ApiKey"`, deadline = Date.now() + 5000;
      while (true) {
        const { rows } = await pool.query(`SELECT count(DISTINCT activity.pid)::int AS n FROM pg_stat_activity activity
          JOIN pg_locks lock ON lock.pid=activity.pid WHERE lock.relation=$1::regclass
          AND activity.datname=current_database() AND activity.wait_event_type='Lock'`, [relation]);
        if (rows[0]?.n >= count) break;
        if (Date.now() >= deadline) throw Error("Authentication usage writes did not reach the held key lock");
        await Bun.sleep(5);
      }
      await beforeCommit?.(blocker);
      await blocker.query("COMMIT");
      return await all;
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await Promise.allSettled(result);
    }
  }

  test("concurrent stale authentications record usage once", context.bind(async () => {
    const f = await fixture(false, true), schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    await db.apiKey.update({ where: { id: f.key.id }, data: { updatedAt: new Date(0) } });
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}".api_key_usage_updates (key_id uuid NOT NULL)`);
    await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".api_key_usage_count() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO "${schema}".api_key_usage_updates VALUES (NEW.id); RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER api_key_usage_count AFTER UPDATE ON "${schema}"."ApiKey" FOR EACH ROW EXECUTE FUNCTION "${schema}".api_key_usage_count()`);
    try {
      const results = await authenticateBehindKeyLock(f.key.id, f.secret, 6);
      expect(results.every(result => result?.apiKeyId === f.key.id)).toBe(true);
      const [updates] = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM api_key_usage_updates WHERE key_id=${f.key.id}::uuid`;
      expect(updates!.n).toBe(1);
      const after = await db.apiKey.findUniqueOrThrow({ where: { id: f.key.id } });
      expect(after.lastUsedAt).not.toBeNull(); expect(after.updatedAt.getTime()).toBeGreaterThan(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER api_key_usage_count ON "${schema}"."ApiKey"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${schema}".api_key_usage_count()`);
      await db.$executeRawUnsafe(`DROP TABLE "${schema}".api_key_usage_updates`);
    }
  }));

  test("a racing revocation prevents the already-read key's usage write and the next authentication", context.bind(async () => {
    const f = await fixture(false, true), revokedAt = new Date();
    const results = await authenticateBehindKeyLock(f.key.id, f.secret, 1, async blocker => {
      await blocker.query('UPDATE "ApiKey" SET "revokedAt"=$1,"updatedAt"=$1 WHERE id=$2::uuid', [revokedAt, f.key.id]);
    });
    // Authentication's current read remains its boundary. The later telemetry
    // update must not overwrite revocation, and a new request must observe it.
    expect(results[0]?.apiKeyId).toBe(f.key.id);
    const after = await db.apiKey.findUniqueOrThrow({ where: { id: f.key.id } });
    expect(after.lastUsedAt).toBeNull(); expect(after.updatedAt).toEqual(revokedAt);
    expect(await service.authenticateApiKey(f.secret)).toBeNull();
  }));
});
