import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { executionSnapshotQuiescenceSchema } from "@narriflow/validators/execution-snapshot";
import { attestQuiescedExecutionSnapshot, fenceExecutionSnapshot, readFencedWorker, validateExecutionSnapshotEvidence, ExecutionSnapshotError } from "../src/execution-snapshot";
import { hashSnapshotFile, hashSnapshotMigrations, readSnapshotJson, writeSnapshotProof } from "./execution-snapshot-files";
import { createExecutionDispatch, ExecutionDispatchError } from "../src/execution-dispatch";
import { ExecutionRestoreService, ExecutionRestoreError } from "../src/execution-restore";
import { ExecutionPageReceiptError } from "../src/execution-page-receipt";
import { parseExecutionRestoreOperatorArgs, restoreWorkflowTarget, createWranglerRestoreCommands, ExecutionRestoreOperatorError } from "../src/execution-restore-operator";

// This command runs under Bun. JSONC is its sole runtime-specific intrinsic;
// all file and child-process boundaries use the standard Node interfaces.
declare const Bun: { JSONC: { parse(input: string): unknown } };
const executeFile = promisify(execFile);
const usage = `execution:restore inspect [--dispatch-id UUID]
execution:restore fence --expected-epoch N
execution:restore attest --snapshot PATH --quiescence PATH --quiescence-evidence PATH --proof-out PATH
execution:restore begin --expected-epoch N --fence-above-epoch N --proof PATH --snapshot PATH
execution:restore resume --dispatch-id UUID
All commands accept --config PATH and --env NAME. Requires explicit DIRECT_URL;
fence/attest/begin/resume also require API_ORIGIN reporting the fenced Worker.
Only a continuously quiesced, fenced snapshot is supported. No command reopens admission.
Uses the repository's pinned Wrangler and existing authentication.`;
const apiDirectory = fileURLToPath(new URL("../../../apps/api/", import.meta.url));
const defaultConfig = fileURLToPath(new URL("../../../apps/api/wrangler.jsonc", import.meta.url));
const wrangler = fileURLToPath(new URL("../../../apps/api/node_modules/.bin/wrangler", import.meta.url));
let database: PrismaClient | undefined;
let committedDispatchIds: readonly string[] = [];
let beginRequested = false;
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function runWrangler(args: readonly string[], accountId: string): Promise<unknown> {
  const env: Record<string, string> = { CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: "false", CI: "true" };
  for (const name of ["PATH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "SYSTEMROOT", "CLOUDFLARE_API_TOKEN"]) {
    const value = process.env[name]; if (value) env[name] = value;
  }
  const { stdout } = await executeFile(wrangler, [...args], { cwd: apiDirectory, env,
    timeout: 30_000, maxBuffer: 1_048_576, encoding: "utf8" });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

try {
  const input = parseExecutionRestoreOperatorArgs(process.argv.slice(2));
  if (input.command === "help") process.stdout.write(`${usage}\n`);
  else {
    const configPath = resolve(input.configPath ?? defaultConfig);
    const target = restoreWorkflowTarget(Bun.JSONC.parse(await readFile(configPath, "utf8")), input.environment);
    const configuredConnection = process.env.DIRECT_URL;
    if (!configuredConnection) throw new ExecutionRestoreOperatorError("restore_operator_configuration_invalid");
    const url = new URL(configuredConnection), schema = url.searchParams.get("schema") ?? "public";
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname.includes("-pooler.") || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new ExecutionRestoreOperatorError("restore_operator_configuration_invalid");
    url.searchParams.delete("options"); url.searchParams.delete("schema");
    const connectionString = url.toString();
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1, options: `-csearch_path=${schema},public` }, { schema }), log: [], transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
    // A missing selected table must not fall through search_path to public.
    const qualified = `"${schema}"."ExecutionEpoch"`, migrationsTable = `"${schema}"."_prisma_migrations"`;
    const [binding] = await database.$queryRaw<Array<{ schema: string; bound: boolean }>>`SELECT current_schema() AS schema,
      (to_regclass(${qualified}) IS NOT NULL AND to_regclass('"ExecutionEpoch"') = to_regclass(${qualified}) AND
       to_regclass(${migrationsTable}) IS NOT NULL AND to_regclass('"_prisma_migrations"') = to_regclass(${migrationsTable})) AS bound`;
    if (!binding?.bound || binding.schema !== schema) throw new ExecutionRestoreOperatorError("restore_operator_configuration_invalid");
    const commands = createWranglerRestoreCommands({ ...target, configPath, environment: input.environment, run: args => runWrangler(args, target.accountId) });
    const dispatch = createExecutionDispatch({ database, scheduler: commands.scheduler, options: { deliveryLeaseMs: 120_000 } });
    const restore = new ExecutionRestoreService({ database, register: async ids => {
      committedDispatchIds = ids;
      for (const id of ids) if ((await dispatch.deliver(id)).status !== "acknowledged") throw new ExecutionDispatchError("scheduler_unavailable");
    } });
    const resource = { environment: input.environment ?? null, accountId: target.accountId, workflowName: target.workflowName, databaseHost: url.hostname, database: url.pathname.slice(1), schema };
    const observeWorker = () => {
      const origin = process.env.API_ORIGIN;
      if (!origin) throw new ExecutionRestoreOperatorError("restore_operator_configuration_invalid");
      return readFencedWorker(origin);
    };
    const localMigrations = () => hashSnapshotMigrations(fileURLToPath(new URL("../../db/prisma/migrations/", import.meta.url)));
    if (input.command === "inspect") {
      const state = input.dispatchId ? await restore.inspect(input.dispatchId) : await restore.inspectCurrent();
      write({ mode: "inspect", resource, state });
    } else if (input.command === "fence") {
      const fenced = await fenceExecutionSnapshot(database, { expectedEpoch: input.expectedEpoch, worker: await observeWorker() });
      write({ mode: "fenced", resource, ...fenced });
    } else if (input.command === "attest") {
      const quiescence = executionSnapshotQuiescenceSchema.parse(await readSnapshotJson(input.quiescencePath));
      if (quiescence.evidenceSha256 !== await hashSnapshotFile(input.quiescenceEvidencePath)) throw new ExecutionSnapshotError("restore_snapshot_proof_invalid");
      const snapshotSha256 = await hashSnapshotFile(input.snapshotPath), localMigrationSha256 = await localMigrations();
      const proof = await attestQuiescedExecutionSnapshot(database, { snapshotSha256, localMigrationSha256, worker: await observeWorker(), quiescence });
      await writeSnapshotProof(input.proofOutputPath, proof);
      write({ mode: "attested", resource, sourceEpoch: proof.sourceEpoch, fencedAt: proof.fencedAt, snapshotSha256: proof.snapshotSha256, identitySha256: proof.identitySha256, proofPath: resolve(input.proofOutputPath) });
    } else if (input.command === "begin") {
      const proof = await readSnapshotJson(input.proofPath), snapshotSha256 = await hashSnapshotFile(input.snapshotPath), localMigrationSha256 = await localMigrations();
      const evidence = await validateExecutionSnapshotEvidence({ proof, snapshotSha256, localMigrationSha256, worker: await observeWorker() });
      beginRequested = true;
      const begun = await restore.begin({ expectedEpoch: input.expectedEpoch, fenceAboveEpoch: input.fenceAboveEpoch, evidence });
      write({ mode: "registered", resource, ...begun, admissionOpen: false });
    } else {
      await observeWorker();
      const before = await restore.inspect(input.dispatchId);
      if (before.admissionOpen) throw new ExecutionRestoreError("restore_epoch_changed");
      const ledger = await dispatch.read(input.dispatchId);
      if (!ledger || JSON.stringify(ledger.reference) !== JSON.stringify(before.reference)) throw new ExecutionRestoreError("restore_reference_invalid");
      const result = await commands.resume(ledger.instanceId, { hasCommittedPage: before.receipt !== null, beforeRestart: async () => {
        await observeWorker();
        const fresh = await restore.inspect(input.dispatchId);
        if (fresh.admissionOpen || JSON.stringify(fresh.reference) !== JSON.stringify(before.reference)) throw new ExecutionRestoreError("restore_epoch_changed");
      } });
      write({ mode: "resume", resource, sourcePair: { snapshotEpoch: before.snapshotEpoch, fenceAboveEpoch: before.fenceAboveEpoch, deploymentEpoch: before.deploymentEpoch }, dispatchId: input.dispatchId, ...result, admissionOpen: false });
    }
  }
} catch (error) {
  const known = error instanceof ExecutionRestoreOperatorError || error instanceof ExecutionRestoreError || error instanceof ExecutionPageReceiptError || error instanceof ExecutionDispatchError || error instanceof ExecutionSnapshotError;
  write({ mode: committedDispatchIds.length ? "registration_pending" : beginRequested ? "begin_unconfirmed" : "failed", code: known ? error.code : "restore_operator_failed", ...(committedDispatchIds.length ? { dispatchIds: committedDispatchIds } : {}),
    ...(error instanceof ExecutionRestoreOperatorError && error.proof ? { proof: error.proof } : {}) });
  process.exitCode = 1;
} finally { await database?.$disconnect(); }
