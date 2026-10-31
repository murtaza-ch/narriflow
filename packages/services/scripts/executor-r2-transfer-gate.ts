/** Operator-only fixture preparation and exact cleanup. Never run on shared dev. */
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { HeadObjectCommand, ListMultipartUploadsCommand, S3Client } from "@aws-sdk/client-s3";
import {FetchHttpHandler} from "@smithy/fetch-http-handler";
import { DatabaseScope } from "@narriflow/db/client";
import { contentPackSchema, PLATFORM_PLAYBOOK_VERSION } from "@narriflow/validators";
import { withServiceEnvironment } from "../src/runtime-environment";
import { readExecutionAdmission, assertExecutionAdmissionOpen } from "../src/execution-admission";
import { getIngestJobLifecycle } from "../src/ingest-job-lifecycle-runtime";
import { prepareIngestSourceExecution } from "../src/ingest-source-execution";
import { prismaUploadSessionPersistence } from "../src/upload-session.service";
import { createExecutionStorage } from "../src/execution-storage";
import { createMediaCleanupStorage } from "../src/media-cleanup-storage";
import { admitMediaCleanupObligations } from "../src/media-cleanup-admission";
import { createMediaCleanupControl, queueMediaCleanupWithinTransaction } from "../src/media-cleanup-control";
import { mediaCleanupObjectRetainUntil } from "../src/media-cleanup-holds";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";

const BYTES = 10 * 1024 ** 3, PART_BYTES = 16 * 1024 ** 2;
type Invocation = { reference: ExecutionDispatchReference; attemptToken: string };
type Phase = { jobId: string; projectId: string; invocation?: Invocation };
interface Journal {
  version: 1; expectedHost: string; expectedDatabase: string; epoch: number;
  userId: string; workspaceId: string; upload: Phase; pin: Phase; uploadSessionId: string;
}
interface NativeReport {
  version: 1; phase: "upload" | "pin"; status: "passed" | "failed"; artifactId: string;
  runId: string; startedAtUnixMs: number; combinedDeadlineUnixMs: number; combinedElapsedSeconds: number;
  object: { key: string; etag: string; byteLength: number; sha256: string };
  stalePartStatus: number; revokedGrantStatus: number;
}
const code = (name: string): never => { throw Error(name); };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function validateGateTarget(value: string, expectedHost: string, expectedDatabase: string) {
  const target = new URL(value);
  if (target.hostname !== expectedHost || target.pathname !== `/${expectedDatabase}` ||
      !expectedHost.endsWith(".aws.neon.tech") || expectedHost.includes("-pooler.") ||
      expectedHost.includes("ep-rough-hill-b57kvyah") || expectedDatabase !== "serverless_pipeline_gates") code("gate_private_database_required");
  return target;
}
function validateJournal(value: Journal) {
  if (value.version !== 1 || !Number.isSafeInteger(value.epoch) || value.epoch < 1 ||
      ![value.userId, value.workspaceId, value.uploadSessionId, value.upload?.jobId, value.upload?.projectId,
        value.pin?.jobId, value.pin?.projectId].every(uuid)) code("gate_journal_invalid");
  return value;
}
export function sourceReceipt(value: NativeReport, journal: Journal) {
  if (value.version !== 1 || value.phase !== "upload" || value.status !== "passed" ||
      value.runId !== journal.upload.invocation?.attemptToken || !uuid(value.artifactId) || value.object?.byteLength !== BYTES ||
      !/^[a-f0-9]{64}$/.test(value.object?.sha256) || !Number.isSafeInteger(value.startedAtUnixMs) ||
      !Number.isSafeInteger(value.combinedDeadlineUnixMs) || !(value.combinedElapsedSeconds > 0 && value.combinedElapsedSeconds < 2700) ||
      value.combinedDeadlineUnixMs > value.startedAtUnixMs + 2700_000 || value.stalePartStatus !== 404 ||
      ![403, 409, 410].includes(value.revokedGrantStatus)) code("gate_upload_report_invalid");
  return { runId: value.runId, object: value.object, startedAtUnixMs: value.startedAtUnixMs, combinedDeadlineUnixMs: value.combinedDeadlineUnixMs };
}
async function save(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
async function privateJson<T>(path: string): Promise<T> {
  const info=await stat(path);
  if (info.mode & 0o077) code("gate_private_file_permissions_required");
  if(info.size>131072)code("gate_private_file_too_large");
  return JSON.parse(await readFile(path, "utf8"));
}
function argumentsForGate() {
  const [phase, ...values] = process.argv.slice(2), args = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index]?.startsWith("--") || !values[index + 1]) code("gate_arguments_invalid");
    args.set(values[index]!, values[index + 1]!);
  }
  const required = (name: string) => args.get(name) ?? code("gate_argument_missing");
  if (!["seed-upload", "bind-pin", "status", "cleanup"].includes(phase ?? "")) code("gate_phase_invalid");
  return { phase, journalPath: resolve(required("--journal")), settingsPath: resolve(required("--settings")),
    expectedHost: required("--expected-host"), expectedDatabase: "serverless_pipeline_gates", epoch: Number(required("--epoch")),
    reportPath: args.get("--report") ? resolve(args.get("--report")!) : undefined };
}

export async function bindVerifiedPinGateFixture(db:PrismaClient,journal:Journal,source:{id:string;storageKey:string;etag:string;contentType:string;multipartUploadId:string|null}) {
        const now = new Date(), pack = contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3,
          clipDurationSecTarget: 45, platformPlaybookVersion: PLATFORM_PLAYBOOK_VERSION });
        await db.$transaction(async tx => {
          const admission = await readExecutionAdmission(tx); assertExecutionAdmissionOpen(admission);
          if (admission.epoch !== journal.epoch) code("gate_epoch_changed");
          await tx.uploadSession.upsert({ where: { id: journal.uploadSessionId }, update: {}, create: {
            id: journal.uploadSessionId, workspaceId: journal.workspaceId, actorUserId: journal.userId, clientIdempotencyKey: journal.uploadSessionId,
            immutableInputFingerprint: `executor-transfer-gate:${source.id}`, preallocatedProjectId: journal.pin.projectId,
            title: "Synthetic transfer-only pin", fileName: "synthetic-source.bin", fileSizeBytes: BigInt(BYTES), contentType: source.contentType,
            browserFingerprint: "private-executor-transfer-gate", generationSettings: { contentPack: pack }, transferKind: "multipart",
            partSizeBytes: PART_BYTES, partCount: BYTES / PART_BYTES, storageKey: source.storageKey, providerUploadId: source.multipartUploadId,
            status: "finalizing", expiresAt: new Date(now.getTime() + 3600_000), hardExpiresAt: new Date(now.getTime() + 3600_000) } });
        });
        // The actual handoff transaction owns Project/ContentPack creation,
        // the UploadSession FK and the immutable verified upload payload.
        await prismaUploadSessionPersistence.handoff({ executionEpoch: journal.epoch, sessionId: journal.uploadSessionId,
          queuedJobId: journal.pin.jobId, verifiedSizeBytes: BYTES, verifiedContentType: source.contentType,
          verifiedEtag: source.etag, updatedAt: now });

}

export async function main() {
  const options = argumentsForGate(), rawUrl = process.env.DIRECT_URL ?? "";
  if (!rawUrl || process.env.DATABASE_URL !== rawUrl) code("gate_direct_urls_must_match");
  validateGateTarget(rawUrl, options.expectedHost, options.expectedDatabase);
  const settings = await privateJson<Record<string, string>>(options.settingsPath);
  if (settings.R2_ACCOUNT_ID !== "5359f28d385b8632c3abee12d1f5b011" || settings.R2_BUCKET !== "narriflow-dev" ||
      !/^[a-f0-9]{64}$/.test(settings.MEDIA_FETCH_TOOLCHAIN_FINGERPRINT ?? "") || settings.YOUTUBE_FETCH_MODE === "local") code("gate_candidate_settings_invalid");
  const config = { accountId: settings.R2_ACCOUNT_ID!, bucket: settings.R2_BUCKET!,
    accessKeyId: settings.R2_ACCESS_KEY_ID!, secretAccessKey: settings.R2_SECRET_ACCESS_KEY! };
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: rawUrl, max: 2 }),
    transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
  let client: S3Client | undefined;
  try {
    const [proof] = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (proof?.name !== options.expectedDatabase) code("gate_database_readback_failed");
    const current = await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    if (current.epoch !== options.epoch) code("gate_epoch_changed");
    let journal: Journal;
    if (options.phase === "seed-upload") {
      try { journal = validateJournal(await privateJson<Journal>(options.journalPath)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        journal = { version: 1, expectedHost: options.expectedHost, expectedDatabase: options.expectedDatabase, epoch: options.epoch,
          userId: randomUUID(), workspaceId: randomUUID(), upload: { jobId: randomUUID(), projectId: randomUUID() },
          pin: { jobId: randomUUID(), projectId: randomUUID() }, uploadSessionId: randomUUID() };
        // Persist every intended identifier before mutation, so a lost local
        // response is repaired using the same explicit fixture IDs.
        await save(options.journalPath, journal);
      }
    } else journal = validateJournal(await privateJson<Journal>(options.journalPath));
    if (journal.expectedHost !== options.expectedHost || journal.expectedDatabase !== options.expectedDatabase ||
        (["status","cleanup"].includes(options.phase!)?journal.epoch>current.epoch:journal.epoch!==current.epoch)) code("gate_journal_target_mismatch");
    const scope = new DatabaseScope({ createClient: () => ({ client: db, dispose: async () => {} }) });
    await withServiceEnvironment(settings, () => scope.run(async () => {
      const lifecycle = getIngestJobLifecycle();
      async function prepare(phase: Phase) {
        const reference = await db.$transaction(tx => lifecycle.queueExecutionWithinTransaction(tx, phase.jobId));
        if (!reference) code("gate_fixture_dispatch_missing");
        const prepared = await prepareIngestSourceExecution({ database: db, domain: lifecycle, reference: reference!,
          toolchainFingerprint: settings.MEDIA_FETCH_TOOLCHAIN_FINGERPRINT!, executionKind: "modal_execution" });
        if (prepared.kind === "waiting") phase.invocation = { reference: prepared.deadline.reference, attemptToken: prepared.deadline.attemptToken };
        else code("gate_fixture_not_prepared");
      }
      if (options.phase === "seed-upload") {
        await db.$transaction(async tx => {
          const admission = await readExecutionAdmission(tx); assertExecutionAdmissionOpen(admission);
          if (admission.epoch !== journal.epoch) code("gate_epoch_changed");
          const known = await tx.ingestJob.findUnique({ where: { id: journal.upload.jobId } });
          if (known) { if (known.projectId !== journal.upload.projectId) code("gate_fixture_conflict"); return; }
          await tx.user.create({ data: { id: journal.userId, clerkId: `executor-r2-gate:${journal.userId}` } });
          await tx.workspace.create({ data: { id: journal.workspaceId, name: "Private regional transfer gate", pricingTier: "business",
            ownerUserId: journal.userId, members: { create: { userId: journal.userId, role: "owner" } } } });
          await tx.project.create({ data: { id: journal.upload.projectId, workspaceId: journal.workspaceId, createdByUserId: journal.userId,
            title: "Synthetic transfer-only upload", sourceMediaUrl: "https://media.example.invalid/executor-transfer-gate", notifyOnComplete: false } });
          await lifecycle.enqueue(tx, { id: journal.upload.jobId, projectId: journal.upload.projectId, jobType: "rss_import",
            acquisition: { audioPolicy: "pending_pack" }, payload: { rssUrl: "https://media.example.invalid/feed",
              episode: { id: journal.upload.jobId, enclosureUrl: "https://media.example.invalid/executor-transfer-gate" } } });
        });
        await prepare(journal.upload); await save(options.journalPath, journal);
        await save(`${options.journalPath}.upload-invocation.json`, journal.upload.invocation);
        return;
      }
      if (options.phase === "bind-pin") {
        const reportPath=options.reportPath??code("gate_report_required");
        const report = await privateJson<NativeReport>(reportPath), receipt = sourceReceipt(report, journal);
        if (Date.now() + 60_000 >= receipt.combinedDeadlineUnixMs) code("gate_combined_deadline_expired");
        const artifact = await db.executionArtifact.findUniqueOrThrow({ where: { id: report.artifactId }, include: { attempt: true } });
        if (artifact.attemptToken !== journal.upload.invocation?.attemptToken || artifact.role !== "source_video" || artifact.committedAt ||
            artifact.attempt.status !== "failed" || !artifact.multipartCompleteIntentAt || artifact.multipartAbortIntentAt ||
            artifact.storageKey !== receipt.object.key || artifact.etag !== receipt.object.etag || artifact.byteLength !== BigInt(BYTES) ||
            artifact.checksumSha256 !== receipt.object.sha256 || artifact.contentType !== "application/octet-stream") code("gate_completed_source_not_verified");
        // Native clocks can differ slightly across hosts. The real SQL
        // operation deadline caps the second phase without extending either.
        receipt.combinedDeadlineUnixMs=Math.min(receipt.combinedDeadlineUnixMs,artifact.attempt.operationDeadlineAt.getTime());
        if(Date.now()+60_000>=receipt.combinedDeadlineUnixMs)code("gate_combined_deadline_expired");
        const head = await createExecutionStorage(config).head({ artifactId: artifact.id, storageKey: artifact.storageKey,
          bindingHash: artifact.bindingHash, contentType: artifact.contentType, byteLength: BYTES });
        if (!head || head.etag !== artifact.etag || head.byteLength !== BYTES) code("gate_completed_source_head_changed");
        await bindVerifiedPinGateFixture(db,journal,{...artifact,etag:artifact.etag!});
        await prepare(journal.pin); await save(options.journalPath, journal);
        await save(`${options.journalPath}.pin-arguments.json`, { invocation: journal.pin.invocation, source: receipt });
        return;
      }
      const phases = [journal.upload, journal.pin].filter(phase => phase.invocation), tokens = phases.map(phase => phase.invocation!.attemptToken);
      const artifacts = await db.executionArtifact.findMany({ where: { attemptToken: { in: tokens } }, take: 10, include: { attempt: true } });
      if (artifacts.length >= 10 || artifacts.some(row => !row.storageKey.startsWith(`execution/${journal.epoch}/${row.attemptToken}/`))) code("gate_assignment_scope_invalid");
      if (options.phase === "status") {
        const jobs = await db.ingestJob.findMany({ where: { id: { in: phases.map(phase => phase.jobId) } },
          select: { id: true, status: true, attemptCount: true, operationDeadlineAt: true, lastError: true } });
        console.log(JSON.stringify({ scope: "transfer only", jobs, artifacts: artifacts.map(({ id, role, byteLength, checksumSha256,
          etag, committedAt, multipartAbortIntentAt, attempt }) => ({ id, role, byteLength: byteLength?.toString(), checksumSha256,
            etag, committedAt, multipartAbortIntentAt, attemptStatus: attempt.status, processStartedAt: attempt.processStartedAt,
            operationDeadlineAt: attempt.operationDeadlineAt,attemptCreatedAt:attempt.createdAt,attemptFinishedAt:attempt.finishedAt })) }));
        return;
      }
      if (artifacts.some(row => !["failed", "cancelled", "expired"].includes(row.attempt.status))) code("gate_live_owner_blocks_cleanup");
      const notBefore = Math.max(...artifacts.map(row => Math.max(row.grantExpiresAt.getTime(), row.attempt.operationDeadlineAt.getTime()) + 120_000));
      if (Date.now() < notBefore) { console.log(JSON.stringify({ cleanup: "waiting", notBefore: new Date(notBefore).toISOString() })); return; }
      await db.$transaction(tx => admitMediaCleanupObligations(tx, artifacts.map(row => ({ origin: "assigned_execution_artifact", cleanupClass: "assigned_artifact",
        objectKey: row.storageKey, projectId: phases.find(phase => phase.invocation!.attemptToken === row.attemptToken)!.projectId,
        notBefore: new Date(notBefore) }))));
      const intents = await db.mediaCleanupObligation.findMany({ where: { origin: "assigned_execution_artifact", cleanupClass: "assigned_artifact",
        objectKey: { in: artifacts.map(row => row.storageKey) } } });
      const pending: string[] = [], cleanup = createMediaCleanupControl({ database: db, storage: createMediaCleanupStorage(config),
        hold: mediaCleanupObjectRetainUntil, register: async ids => { pending.push(...ids); } });
      for (const intent of intents) {
        const reference = await db.$transaction(tx => queueMediaCleanupWithinTransaction(tx, intent.id));
        if (reference) await cleanup.run(reference);
      }
      const remaining = await db.mediaCleanupObligation.count({ where: { id: { in: intents.map(row => row.id) }, completedAt: null } });
      if (remaining || pending.length) code("gate_cleanup_obligation_pending");
      client = new S3Client({ region: "auto", endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 1,
        requestHandler:new FetchHttpHandler({requestTimeout:30000}) });
      const proofs = [];
      for (const artifact of artifacts) {
        let missing = false;
        try { await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: artifact.storageKey })); }
        catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) missing = true; else throw error; }
        const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: config.bucket, Prefix: artifact.storageKey, MaxUploads: 9 }));
        if (!missing || uploads.IsTruncated || uploads.Uploads?.some(value => value.Key === artifact.storageKey)) code("gate_cleanup_storage_not_empty");
        proofs.push({ artifactId: artifact.id, headStatus: 404, exactKeyMultipartUploads: 0 });
      }
      await save(`${options.journalPath}.cleanup.json`, { passed: true, proofs, fixtureRowsRetainedForAudit: true });
      console.log(JSON.stringify({ cleanup: "passed", objectsVerifiedAbsent: proofs.length, exactKeyMultipartUploads: 0 }));
    }));
  } finally { client?.destroy(); await db.$disconnect(); }
}
if (import.meta.main) await main().catch(error => {
  console.error(JSON.stringify({ failed: true, code: error instanceof Error && /^gate_[a-z_]+$/.test(error.message) ? error.message : "gate_operator_unconfirmed" }));
  process.exitCode = 1;
});
