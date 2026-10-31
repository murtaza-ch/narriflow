import type { Prisma, PrismaClient } from "@prisma/client";
import { executionSnapshotOriginSchema, executionSnapshotQuiescenceSchema, fencedWorkerEvidenceSchema, restoreWorkerEvidenceSchema, quiescedExecutionSnapshotSchema,
  type RestoreWorkerEvidence,type FencedWorkerEvidence, type ExecutionSnapshotQuiescence, type QuiescedExecutionSnapshot } from "@narriflow/validators/execution-snapshot";

export class ExecutionSnapshotError extends Error {
  constructor(readonly code: "restore_snapshot_proof_invalid" | "restore_snapshot_proof_required" | "restore_snapshot_history_unknown" | "restore_worker_not_fenced" | "restore_worker_mode_invalid") { super(code); }
}
const invalid = () => new ExecutionSnapshotError("restore_snapshot_proof_invalid");
async function hash(value: unknown) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, "0")).join(""); }
export function executionSnapshotIdentityHash(value: Pick<QuiescedExecutionSnapshot, "sourceEpoch" | "fencedAt" | "schema" | "accountId" | "worker" | "migrationSha256">) {
  return hash(["fenced-execution-snapshot-v1", value.sourceEpoch, value.fencedAt, value.schema, value.accountId, value.worker.origin, value.worker.version, value.migrationSha256]);
}
export function executionSnapshotQuiescenceHash(value: ExecutionSnapshotQuiescence) { return hash(executionSnapshotQuiescenceSchema.parse(value)); }
export interface ExecutionSnapshotEvidence { proof: QuiescedExecutionSnapshot; proofHash: string; worker: FencedWorkerEvidence; localMigrationSha256: string }
/** File and live platform observations are computed by the operator before SQL.
 * Domain authority still requires the exclusive database fence checks below. */
export async function validateExecutionSnapshotEvidence(input: { proof: unknown; snapshotSha256: string; localMigrationSha256: string; worker: FencedWorkerEvidence }): Promise<ExecutionSnapshotEvidence> {
  const parsed = quiescedExecutionSnapshotSchema.safeParse(input.proof), observed = fencedWorkerEvidenceSchema.safeParse(input.worker);
  if (!parsed.success || !observed.success) throw invalid();
  const proof = parsed.data;
  if (proof.snapshotSha256 !== input.snapshotSha256 || proof.migrationSha256 !== input.localMigrationSha256 || proof.worker.origin !== observed.data.origin || proof.worker.version !== observed.data.version ||
    proof.identitySha256 !== await executionSnapshotIdentityHash(proof) || proof.quiescenceSha256 !== await executionSnapshotQuiescenceHash(proof.quiescence)) throw invalid();
  return { proof, proofHash: await hash(proof), worker: observed.data, localMigrationSha256: input.localMigrationSha256 };
}
type WorkerReadOptions={fetch?(input:string,init:RequestInit):Promise<Response>};
export async function readFencedWorker(origin:string,options:WorkerReadOptions={}):Promise<FencedWorkerEvidence>{return fencedWorkerEvidenceSchema.parse(await readRestoreWorker(origin,"fenced",options));}
export function readRestoreResumeWorker(origin:string,metadataReady:boolean,options:WorkerReadOptions={}):Promise<RestoreWorkerEvidence>{return readRestoreWorker(origin,metadataReady?"closed":"fenced",options);}
async function readRestoreWorker(origin:string,expected:"fenced"|"closed",options:WorkerReadOptions):Promise<RestoreWorkerEvidence>{
 const badMode=()=>new ExecutionSnapshotError(expected==="fenced"?"restore_worker_not_fenced":"restore_worker_mode_invalid");
  if (!executionSnapshotOriginSchema.safeParse(origin).success) throw invalid();
  let response: Response;
  try { response = await (options.fetch ?? fetch)(`${origin}/api/health`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) }); }
  catch { throw badMode(); }
  if (!response.ok || !response.headers.get("cache-control")?.split(",").some(value => value.trim().toLowerCase() === "no-store") || !response.body) throw badMode();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 4096) throw invalid(); chunks.push(chunk.value); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("service" in value) || value.service !== "narriflow-api" || !("version" in value) || !("admissionState" in value)) throw invalid();
    const parsed = restoreWorkerEvidenceSchema.safeParse({ origin, version: value.version, admissionState: value.admissionState });
    if (!parsed.success||parsed.data.admissionState!==expected) throw badMode();
    return parsed.data;
  } catch (error) { await reader.cancel().catch(() => {}); if (error instanceof ExecutionSnapshotError) throw error; throw invalid(); }
  finally { reader.releaseLock(); }
}

/** Completed migration facts, not timestamps or an assumed version label. */
export async function readExecutionSnapshotMigrationHash(tx: Pick<Prisma.TransactionClient, "$queryRaw">): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ name: string; checksum: string; finishedAt: Date | null }>>`SELECT migration_name AS name, checksum, finished_at AS "finishedAt" FROM "_prisma_migrations" WHERE rolled_back_at IS NULL ORDER BY migration_name LIMIT 4097`;
  if (!rows.length || rows.length > 4096 || rows.some(row => !row.finishedAt || !/^[a-f0-9]{64}$/.test(row.checksum)) || new Set(rows.map(row => row.name)).size !== rows.length) throw invalid();
  return hash(rows.map(row => [row.name, row.checksum]));
}
/** Snapshot proof validates a fenced source with no later permission lineage.
 * The caller holds ExecutionEpoch FOR UPDATE before reading these facts. */
export async function assertExecutionSnapshotDatabase(tx: Prisma.TransactionClient, evidence: ExecutionSnapshotEvidence, input: { expectedEpoch: number; fenceAboveEpoch: number; epoch: number; admissionOpen: boolean; changedAt: Date }) {
  const { proof } = evidence;
  if (input.fenceAboveEpoch > proof.sourceEpoch) throw new ExecutionSnapshotError("restore_snapshot_history_unknown");
  if (input.expectedEpoch !== proof.sourceEpoch || input.fenceAboveEpoch !== proof.sourceEpoch || input.epoch !== proof.sourceEpoch || input.admissionOpen || input.changedAt.toISOString() !== proof.fencedAt) throw invalid();
  const [binding] = await tx.$queryRaw<Array<{ schema: string; now: Date }>>`SELECT current_schema() AS schema, clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  if (!binding || binding.schema !== proof.schema || new Date(proof.quiescence.verifiedAt) > binding.now || proof.migrationSha256 !== await readExecutionSnapshotMigrationHash(tx)) throw invalid();
  await noPermissions(tx, proof.sourceEpoch);
}

async function noPermissions(tx: Prisma.TransactionClient, epoch: number) {
  const [later] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "ExecutionDispatch" WHERE "deploymentEpoch" >= ${epoch} LIMIT 1`;
  if (later) throw new ExecutionSnapshotError("restore_snapshot_history_unknown");
}
/** Operator-only standalone fence before capture. It intentionally creates no
 * new execution permission. The no-tail source remains idle until recovery. */
export async function fenceExecutionSnapshot(database: PrismaClient, input: { expectedEpoch: number; worker: FencedWorkerEvidence }) {
  if (!fencedWorkerEvidenceSchema.safeParse(input.worker).success || !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 1 || input.expectedEpoch >= 2_147_483_646) throw invalid();
  return database.$transaction(async tx => {
    const [row] = await tx.$queryRaw<Array<{ epoch: number; admissionOpen: boolean; changedAt: Date }>>`SELECT epoch, "admissionOpen", "changedAt" FROM "ExecutionEpoch" WHERE id = 1 FOR UPDATE`;
    if (!row) throw invalid();
    if (row.epoch === input.expectedEpoch + 1 && !row.admissionOpen) {
      await noPermissions(tx, row.epoch);
      return { sourceEpoch: row.epoch, fencedAt: row.changedAt.toISOString(), admissionOpen: false as const };
    }
    if (row.epoch !== input.expectedEpoch) throw new ExecutionSnapshotError("restore_snapshot_history_unknown");
    const next = await tx.executionEpoch.update({ where: { id: 1 }, data: { epoch: row.epoch + 1, admissionOpen: false, changedAt: (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`)[0]!.now } });
    await noPermissions(tx, next.epoch);
    return { sourceEpoch: next.epoch, fencedAt: next.changedAt.toISOString(), admissionOpen: false as const };
  });
}
/** Creates a private operator proof after a fenced capture and before the
 * snapshot is restored. No data, owner or budget is changed by attestation. */
export async function attestQuiescedExecutionSnapshot(database: PrismaClient, input: { snapshotSha256: string; localMigrationSha256: string; worker: FencedWorkerEvidence; quiescence: ExecutionSnapshotQuiescence }): Promise<QuiescedExecutionSnapshot> {
  const worker = fencedWorkerEvidenceSchema.safeParse(input.worker), quiescence = executionSnapshotQuiescenceSchema.safeParse(input.quiescence);
  if (!worker.success || !quiescence.success) throw invalid();
  return database.$transaction(async tx => {
    const [row] = await tx.$queryRaw<Array<{ epoch: number; admissionOpen: boolean; changedAt: Date }>>`SELECT epoch, "admissionOpen", "changedAt" FROM "ExecutionEpoch" WHERE id = 1 FOR UPDATE`;
    const [binding] = await tx.$queryRaw<Array<{ schema: string; now: Date }>>`SELECT current_schema() AS schema, clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    if (!row || row.admissionOpen || !binding || new Date(quiescence.data.verifiedAt) > binding.now) throw invalid();
    await noPermissions(tx, row.epoch);
    const migrationSha256 = await readExecutionSnapshotMigrationHash(tx);
    if (migrationSha256 !== input.localMigrationSha256) throw invalid();
    const value = { version: 1 as const, sourceEpoch: row.epoch, fencedAt: row.changedAt.toISOString(), schema: binding.schema,
      accountId: "5359f28d385b8632c3abee12d1f5b011" as const, worker: worker.data, migrationSha256, snapshotSha256: input.snapshotSha256,
      quiescence: quiescence.data, identitySha256: "", quiescenceSha256: "" };
    value.identitySha256 = await executionSnapshotIdentityHash(value);
    value.quiescenceSha256 = await executionSnapshotQuiescenceHash(value.quiescence);
    const parsed = quiescedExecutionSnapshotSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    return parsed.data;
  });
}
