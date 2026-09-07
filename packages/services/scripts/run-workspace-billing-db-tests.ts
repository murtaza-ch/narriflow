import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

function envValue(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== key) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

const repositoryRoot = resolve(import.meta.dir, "../../..");
const databaseUrl =
  process.env.WORKSPACE_BILLING_TEST_DATABASE_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  envValue(resolve(repositoryRoot, "packages/db/.env"), "DIRECT_URL") ??
  envValue(resolve(repositoryRoot, "packages/db/.env"), "DATABASE_URL") ??
  envValue(resolve(repositoryRoot, "apps/web/.env.local"), "DIRECT_URL") ??
  envValue(resolve(repositoryRoot, "apps/web/.env.local"), "DATABASE_URL");

if (!databaseUrl) throw new Error("DIRECT_URL or DATABASE_URL is required");

const schema =
  process.env.WORKSPACE_BILLING_TEST_DATABASE_SCHEMA ??
  `workspace_billing_test_${randomUUID().replaceAll("-", "")}`;
if (!/^workspace_billing_test_[a-z0-9_]+$/.test(schema)) {
  throw new Error("Unsafe Workspace Billing test schema name");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const migrationsRoot = resolve(repositoryRoot, "packages/db/prisma/migrations");
const cutoverMigration = "20260828100000_workspace_entitlement_cutover";
const representativeFixtureMigration = "20260828130000_replayable_workspace_checkout";

const migrationDirectories = readdirSync(migrationsRoot)
  .filter((entry) => /^\d+_/.test(entry))
  .sort();

async function applyMigrations(
  schemaName: string,
  predicate: (directory: string) => boolean,
) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schemaName}"`);
    for (const directory of migrationDirectories.filter(predicate)) {
      const sql = readFileSync(
        resolve(migrationsRoot, directory, "migration.sql"),
        "utf8",
      );
      await client.query(sql);
    }
  } finally {
    client.release();
  }
}

async function seedLegacyBillingFixtures(schemaName: string, consistent: boolean) {
  const client = await pool.connect();
  const ownerId = randomUUID();
  const personalWorkspaceId = randomUUID();
  const collaborativeWorkspaceId = randomUUID();
  const observedAt = "2026-08-20T09:00:00.000Z";
  try {
    await client.query(`SET search_path TO "${schemaName}"`);
    await client.query(
      `INSERT INTO "User" (id, "clerkId", "primaryEmail", "pricingTier", "stripeCustomerId", "billingEventCreatedAt", "updatedAt")
       VALUES ($1, $2, $3, 'pro', 'cus_personal_fixture', $4, CURRENT_TIMESTAMP)`,
      [ownerId, `migration-${ownerId}`, `migration-${ownerId}@example.test`, observedAt],
    );
    await client.query(
      `INSERT INTO "Workspace" (id, name, "ownerUserId", "personalOwnerUserId", "pricingTier", "stripeCustomerId", "stripeSubscriptionId", "billingInterval", "billingEventCreatedAt", "subscriptionEndsAt", "updatedAt")
       VALUES ($1, 'Personal fixture', $2, $2, $3, $4, 'sub_personal_fixture', 'monthly', $5, '2026-09-20T09:00:00.000Z', CURRENT_TIMESTAMP)`,
      [
        personalWorkspaceId,
        ownerId,
        consistent ? "pro" : "free",
        consistent ? "cus_personal_fixture" : "cus_mismatch",
        observedAt,
      ],
    );
    await client.query(
      `INSERT INTO "Workspace" (id, name, "ownerUserId", "pricingTier", "stripeCustomerId", "stripeSubscriptionId", "billingInterval", "billingEventCreatedAt", "subscriptionEndsAt", "updatedAt")
       VALUES ($1, 'Collaborative fixture', $2, 'business', 'cus_collaborative_fixture', 'sub_collaborative_fixture', 'annual', $3, '2027-08-20T09:00:00.000Z', CURRENT_TIMESTAMP)`,
      [collaborativeWorkspaceId, ownerId, observedAt],
    );
    await client.query(
      `INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role, "updatedAt")
       VALUES ($1, $2, $3, 'owner', CURRENT_TIMESTAMP), ($4, $5, $3, 'owner', CURRENT_TIMESTAMP)`,
      [randomUUID(), personalWorkspaceId, ownerId, randomUUID(), collaborativeWorkspaceId],
    );
  } finally {
    client.release();
  }
}

async function seedRepresentativeBillingFixtures(schemaName: string) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schemaName}"`);
    const owner = await client.query<{ id: string }>(
      `SELECT id FROM "User" ORDER BY id LIMIT 1`,
    );
    const ownerId = owner.rows[0]?.id;
    if (!ownerId) throw new Error("Representative billing fixtures need an owner");
    const fixtures = [
      {
        name: "Pending fixture",
        workspaceId: randomUUID(),
        workspaceTier: "free",
        workspaceStatus: "pending_payment",
        customerId: "cus_pending_fixture",
        subscriptionId: null,
        providerStatus: "incomplete",
        health: "activating",
        attentionReason: null,
      },
      {
        name: "Past-due fixture",
        workspaceId: randomUUID(),
        workspaceTier: "pro",
        workspaceStatus: "active",
        customerId: "cus_past_due_fixture",
        subscriptionId: "sub_past_due_fixture",
        providerStatus: "past_due",
        health: "payment_action_required",
        attentionReason: null,
      },
      {
        name: "Conflicted fixture",
        workspaceId: randomUUID(),
        workspaceTier: "business",
        workspaceStatus: "active",
        customerId: "cus_conflicted_fixture",
        subscriptionId: "sub_conflicted_fixture",
        providerStatus: "active",
        health: "attention_required",
        attentionReason: "multiple_entitlement_subscriptions",
      },
    ] as const;
    for (const fixture of fixtures) {
      await client.query(
        `INSERT INTO "Workspace" (id, name, "ownerUserId", "pricingTier", status, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [
          fixture.workspaceId,
          fixture.name,
          ownerId,
          fixture.workspaceTier,
          fixture.workspaceStatus,
        ],
      );
      await client.query(
        `INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role, "updatedAt")
         VALUES ($1, $2, $3, 'owner', CURRENT_TIMESTAMP)`,
        [randomUUID(), fixture.workspaceId, ownerId],
      );
      await client.query(
        `INSERT INTO "WorkspaceBillingAccount" (
          "workspaceId", "providerCustomerId", "canonicalSubscriptionId",
          "providerStatus", "health", "attentionReason", "firstPastDueAt",
          "graceDeadlineAt", "lastVerifiedAt", "nextReconcileAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6,
          CASE WHEN $4 = 'past_due' THEN '2026-08-20T09:00:00.000Z'::timestamp ELSE NULL END,
          CASE WHEN $4 = 'past_due' THEN '2026-08-27T09:00:00.000Z'::timestamp ELSE NULL END,
          '2026-08-20T09:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          fixture.workspaceId,
          fixture.customerId,
          fixture.subscriptionId,
          fixture.providerStatus,
          fixture.health,
          fixture.attentionReason,
        ],
      );
    }
  } finally {
    client.release();
  }
}

async function verifyMigratedFixtures(schemaName: string) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schemaName}"`);
    const accounts = await client.query<{
      name: string;
      pricingTier: string;
      providerCustomerId: string | null;
      canonicalSubscriptionId: string | null;
    }>(
      `SELECT w.name, w."pricingTier", a."providerCustomerId", a."canonicalSubscriptionId"
       FROM "Workspace" w
       JOIN "WorkspaceBillingAccount" a ON a."workspaceId" = w.id
       WHERE w.name IN ('Personal fixture', 'Collaborative fixture')
       ORDER BY w.name`,
    );
    if (
      JSON.stringify(accounts.rows) !==
      JSON.stringify([
        {
          name: "Collaborative fixture",
          pricingTier: "business",
          providerCustomerId: "cus_collaborative_fixture",
          canonicalSubscriptionId: "sub_collaborative_fixture",
        },
        {
          name: "Personal fixture",
          pricingTier: "pro",
          providerCustomerId: "cus_personal_fixture",
          canonicalSubscriptionId: "sub_personal_fixture",
        },
      ])
    ) {
      throw new Error(`Workspace Billing migration did not preserve fixtures: ${JSON.stringify(accounts.rows)}`);
    }
    const retiredColumns = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM information_schema.columns
       WHERE table_schema = $1
         AND ((table_name = 'User' AND column_name IN ('pricingTier', 'stripeCustomerId', 'billingEventCreatedAt'))
           OR (table_name = 'Workspace' AND column_name IN ('stripeCustomerId', 'stripeSubscriptionId', 'billingInterval', 'billingEventCreatedAt', 'subscriptionEndsAt')))`,
      [schemaName],
    );
    if (retiredColumns.rows[0]?.count !== "0") {
      throw new Error("Workspace Billing migration retained obsolete billing columns");
    }
    const representative = await client.query<{
      name: string;
      status: string;
      health: string;
      providerStatus: string | null;
      attentionReason: string | null;
    }>(
      `SELECT w.name, w.status, a.health, a."providerStatus", a."attentionReason"
       FROM "Workspace" w
       JOIN "WorkspaceBillingAccount" a ON a."workspaceId" = w.id
       WHERE w.name IN ('Pending fixture', 'Past-due fixture', 'Conflicted fixture')
       ORDER BY w.name`,
    );
    if (
      JSON.stringify(representative.rows) !==
      JSON.stringify([
        {
          name: "Conflicted fixture",
          status: "active",
          health: "attention_required",
          providerStatus: "active",
          attentionReason: "multiple_entitlement_subscriptions",
        },
        {
          name: "Past-due fixture",
          status: "active",
          health: "payment_action_required",
          providerStatus: "past_due",
          attentionReason: null,
        },
        {
          name: "Pending fixture",
          status: "pending_payment",
          health: "activating",
          providerStatus: "incomplete",
          attentionReason: null,
        },
      ])
    ) {
      throw new Error(
        `Workspace Billing migration did not preserve representative states: ${JSON.stringify(representative.rows)}`,
      );
    }
  } finally {
    client.release();
  }
}

async function run(command: string[], env: Record<string, string>) {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
}

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  const invalidSchema = `${schema}_invalid`;
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${invalidSchema}"`);
  await applyMigrations(schema, (directory) => directory < cutoverMigration);
  await seedLegacyBillingFixtures(schema, true);
  await applyMigrations(
    schema,
    (directory) =>
      directory >= cutoverMigration && directory < representativeFixtureMigration,
  );
  await seedRepresentativeBillingFixtures(schema);
  await applyMigrations(
    schema,
    (directory) => directory >= representativeFixtureMigration,
  );
  await verifyMigratedFixtures(schema);

  await applyMigrations(invalidSchema, (directory) => directory < cutoverMigration);
  await seedLegacyBillingFixtures(invalidSchema, false);
  let rejectedInconsistentFixture = false;
  try {
    await applyMigrations(
      invalidSchema,
      (directory) => directory === cutoverMigration,
    );
  } catch (error) {
    rejectedInconsistentFixture =
      error instanceof Error && error.message.includes("cutover rejected inconsistent");
  }
  if (!rejectedInconsistentFixture) {
    throw new Error("Workspace Billing cutover accepted inconsistent legacy fixtures");
  }

  const testUrl = new URL(databaseUrl);
  for (const url of [testUrl]) {
    if (url.hostname.includes("-pooler.")) {
      url.hostname = url.hostname.replace("-pooler.", ".");
    }
  }
  testUrl.searchParams.set("options", `-csearch_path=${schema}`);
  await run(["bun", "test", "packages/services/src/workspace-billing.db.test.ts"], {
    ALLOW_WORKSPACE_BILLING_DB_TESTS: "1",
    DATABASE_URL: testUrl.toString(),
    DIRECT_URL: testUrl.toString(),
    WORKSPACE_BILLING_TEST_DATABASE_URL: testUrl.toString(),
    WORKSPACE_BILLING_TEST_DATABASE_SCHEMA: schema,
  });
} finally {
  if (process.env.WORKSPACE_BILLING_TEST_KEEP_SCHEMA !== "1") {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}_invalid" CASCADE`);
  }
  await pool.end();
}
