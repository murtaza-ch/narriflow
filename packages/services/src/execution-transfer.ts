import type { ExecutionArtifact, Prisma, PrismaClient } from "@prisma/client";
import { executionOutputDescriptorSchema, executionPartPlanSchema, executionTransferCommandSchema, executionTransferDispositionSchema,
  EXECUTION_TRANSFER_PART_BYTES, type ExecutionOutputDescriptor, type ExecutionPartPlan, type ExecutionTransferCommand, type ExecutionTransferDisposition } from "@narriflow/validators/execution-transfer";
import { executionMediaFunctionSchema } from "@narriflow/validators/execution";
import type { ExecutorLiveAuthority } from "./executor-control";
import { ExecutorControlError } from "./executor-control";
import type { VerifiedExecutionRequest } from "./execution-signature";
import { ExecutionStorageError, type createExecutionStorage, type ExecutionPinSource, type ExecutionMultipartAssignment } from "./execution-storage";

type Tx = Prisma.TransactionClient;
type Authority = {
  authorize(fence: unknown, requireStarted?: boolean): Promise<ExecutorLiveAuthority>;
  withAuthority<T>(fence: unknown, requireStarted: boolean, work: (tx: Tx, authority: ExecutorLiveAuthority) => Promise<T>): Promise<T>;
};
export interface ExecutionPreparedPackage {
  input: { kind: "inline"; command: Prisma.JsonValue } | { kind: "object" };
  sources: readonly (ExecutionPinSource & { name: string; sha256?: string })[];
  outputs: readonly ExecutionOutputDescriptor[];
}
interface Options {
  database: PrismaClient;
  authority: Authority;
  storage: ReturnType<typeof createExecutionStorage>;
  /** Domain-specific resolvers validate their immutable command schema. No SQL
   * client, transaction, grant or permission escapes this request. */
  resolvePackage(authority: ExecutorLiveAuthority): Promise<ExecutionPreparedPackage>;
  resolvePinSource?(row: Readonly<ExecutionArtifact>, authority: ExecutorLiveAuthority): Promise<ExecutionPinSource>;
}

const contentTypes: Readonly<Record<string, readonly string[]>> = {
  source_audio: ["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg", "audio/aac"],
  source_video: ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "audio/mpeg", "audio/mp4", "audio/wav", "audio/aac"],
  render_variant: ["video/mp4"], layout_evidence: ["application/json"], probe: ["application/json", "audio/wav"],
  thumbnail: ["image/png", "image/jpeg", "image/webp"], export_bundle: ["application/zip"], dub_mix: ["video/mp4", "audio/wav", "audio/mpeg", "audio/mp4"],
  validated_font: ["font/ttf", "font/otf", "font/woff2", "application/font-sfnt", "application/x-font-ttf", "application/x-font-opentype", "application/octet-stream"],
  validated_asset: ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/quicktime", "video/webm", "video/x-matroska"],
  outbound_receipt: ["application/json"],
};
const invalid = (): never => { throw new ExecutorControlError("artifact_invalid"); };
const pending = { disposition: "transfer_pending" };
function isPending(value: Prisma.JsonValue) { return value !== null && typeof value === "object" && !Array.isArray(value) && value.disposition === "transfer_pending"; }
function wireGrant(value: { url: string; headers: Record<string, string>; expiresAt: Date }) { return { ...value, expiresAt: value.expiresAt.toISOString() }; }
function assignment(row: ExecutionArtifact): ExecutionMultipartAssignment {
  if (!row.multipartUploadId || !row.uploadByteLength) return invalid();
  return { artifactId: row.id, storageKey: row.storageKey, bindingHash: row.bindingHash, contentType: row.contentType,
    byteLength: Number(row.uploadByteLength), uploadId: row.multipartUploadId, partSizeBytes: EXECUTION_TRANSFER_PART_BYTES };
}
function partBytes(row: ExecutionArtifact, number: number) {
  if (!row.uploadByteLength || number < 1 || number > Math.ceil(Number(row.uploadByteLength) / EXECUTION_TRANSFER_PART_BYTES)) return invalid();
  return Math.min(EXECUTION_TRANSFER_PART_BYTES, Number(row.uploadByteLength) - (number - 1) * EXECUTION_TRANSFER_PART_BYTES);
}

/** Only assigned outputs and exact frozen reads. Never accepts a storage key or URL. */
export function createExecutionTransfer(options: Options) {
  const db = options.database;
  async function row(tx: Tx, id: string, authority: ExecutorLiveAuthority) {
    await tx.$queryRaw`SELECT "id" FROM "ExecutionArtifact" WHERE "id"=${id}::uuid FOR UPDATE`;
    const found = await tx.executionArtifact.findUnique({ where: { id } });
    const prefix = `execution/${authority.fence.reference.deploymentEpoch}/${authority.fence.attemptToken}/${authority.fence.owner}/`;
    if (!found || found.attemptToken !== authority.fence.attemptToken || found.owner !== authority.fence.owner || !found.storageKey.startsWith(prefix)) return invalid();
    return found;
  }
  async function readReceipt(verified: VerifiedExecutionRequest) {
    const found = await db.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: verified.metadata.audience, deliveryId: verified.metadata.deliveryId } } });
    if (found && found.requestHash !== verified.requestHash) throw new ExecutorControlError("replay_conflict");
    return found && !isPending(found.disposition) ? executionTransferDispositionSchema.parse(found.disposition) : null;
  }
  async function begin(verified: VerifiedExecutionRequest, command: ExecutionTransferCommand) {
    return db.$transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number; now: Date }>>`SELECT "epoch",clock_timestamp() AT TIME ZONE 'UTC' AS "now" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      if (!epoch || epoch.epoch !== command.fence.reference.deploymentEpoch) throw new ExecutorControlError("authority_lost");
      const lock = `executor-inbox:${verified.metadata.audience}:${verified.metadata.deliveryId}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock},0)) IS NULL AS "locked"`;
      const prior = await tx.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: verified.metadata.audience, deliveryId: verified.metadata.deliveryId } } });
      if (prior) {
        if (prior.requestHash !== verified.requestHash) throw new ExecutorControlError("replay_conflict");
        return isPending(prior.disposition) ? null : executionTransferDispositionSchema.parse(prior.disposition);
      }
      await tx.executionInboxReceipt.create({ data: { audience: verified.metadata.audience, deliveryId: verified.metadata.deliveryId, requestHash: verified.requestHash,
        keyId: verified.metadata.keyId, disposition: pending, committedAt: epoch.now, expiresAt: new Date(epoch.now.getTime() + 7 * 24 * 60 * 60_000) } });
      return null;
    });
  }
  async function finish(verified: VerifiedExecutionRequest, command: ExecutionTransferCommand, result: ExecutionTransferDisposition) {
    const value = executionTransferDispositionSchema.parse(result);
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024) throw new ExecutorControlError("artifact_invalid");
    return options.authority.withAuthority(command.fence, command.action !== "work-package", async (tx, authority) => {
      if (value.disposition === "upload_parts" || value.disposition === "source_range") {
        const current = await row(tx, value.artifactId, authority);
        if (current.committedAt || current.multipartCompleteIntentAt || current.multipartAbortIntentAt) return invalid();
        const expires = value.disposition === "upload_parts" ? value.grants.map(grant => Date.parse(grant.expiresAt)) : [Date.parse(value.grant.expiresAt)];
        await tx.executionArtifact.update({ where: { id: current.id }, data: { grantExpiresAt: new Date(Math.max(current.grantExpiresAt.getTime(), ...expires)) } });
      }
      const where = { audience: verified.metadata.audience, deliveryId: verified.metadata.deliveryId, requestHash: verified.requestHash };
      await tx.executionInboxReceipt.updateMany({ where: { ...where, disposition: { equals: pending } }, data: { disposition: value as Prisma.InputJsonValue } });
      const winner = await tx.executionInboxReceipt.findUniqueOrThrow({ where: { audience_deliveryId: { audience: where.audience, deliveryId: where.deliveryId } } });
      if (winner.requestHash !== verified.requestHash) throw new ExecutorControlError("replay_conflict");
      return executionTransferDispositionSchema.parse(winner.disposition);
    });
  }
  async function plan(command: Exclude<ExecutionTransferCommand, { action: "work-package" | "source-read" }>) {
    return options.authority.withAuthority(command.fence, true, async (tx, authority) => row(tx, command.artifactId, authority));
  }
  async function initialize(command: Extract<ExecutionTransferCommand, { action: "upload-initialize" }>) {
    let record = await options.authority.withAuthority(command.fence, true, async (tx, authority) => {
      const found = await row(tx, command.artifactId, authority);
      if (found.committedAt || found.multipartCompleteIntentAt || found.multipartAbortIntentAt || !contentTypes[found.role]?.includes(command.contentType) || BigInt(command.byteLength) > found.maxBytes ||
        (found.sourceByteLength !== null && found.sourceByteLength !== BigInt(command.byteLength)) ||
        (found.uploadByteLength !== null && (found.uploadByteLength !== BigInt(command.byteLength) || found.contentType !== command.contentType))) return invalid();
      return found.uploadByteLength !== null ? found : tx.executionArtifact.update({ where: { id: found.id }, data: { uploadByteLength: BigInt(command.byteLength), contentType: command.contentType, multipartPartChecksums: [] } });
    });
    if (!record.multipartUploadId) {
      const existing = await options.storage.findUnfinished(record.storageKey);
      const created = existing[0]?.uploadId ?? (await options.storage.create({ artifactId: record.id, storageKey: record.storageKey, bindingHash: record.bindingHash, contentType: record.contentType, byteLength: command.byteLength })).uploadId;
      record = await options.authority.withAuthority(command.fence, true, async (tx, authority) => {
        const current = await row(tx, command.artifactId, authority);
        if (current.committedAt || current.multipartCompleteIntentAt || current.multipartAbortIntentAt) return invalid();
        return current.multipartUploadId ? current : tx.executionArtifact.update({ where: { id: current.id }, data: { multipartUploadId: created } });
      });
      if (record.multipartUploadId !== created && !existing.length) await options.storage.abort({ ...assignment(record), uploadId: created });
    }
    const value = assignment(record);
    return { disposition: "upload_ready" as const, artifactId: record.id, uploadId: value.uploadId, byteLength: value.byteLength, partSizeBytes: EXECUTION_TRANSFER_PART_BYTES,
      partCount: Math.ceil(value.byteLength / EXECUTION_TRANSFER_PART_BYTES) };
  }
  async function uploadParts(command: Extract<ExecutionTransferCommand, { action: "upload-parts" }>) {
    const record = await options.authority.withAuthority(command.fence, true, async (tx, authority) => {
      const found = await row(tx, command.artifactId, authority);
      if (found.committedAt || found.multipartCompleteIntentAt || found.multipartAbortIntentAt) return invalid();
      assignment(found);
      const parts: ExecutionPartPlan = executionPartPlanSchema.parse(found.multipartPartChecksums ?? []);
      for (const part of command.parts) {
        if (part.byteLength !== partBytes(found, part.partNumber)) return invalid();
        while (parts.length < part.partNumber) parts.push(null);
        const tuple: [number, string, string] = [part.byteLength, part.checksumMd5, part.checksumSha256];
        const prior = parts[part.partNumber - 1];
        if (prior && JSON.stringify(prior) !== JSON.stringify(tuple)) return invalid();
        parts[part.partNumber - 1] = tuple;
      }
      return tx.executionArtifact.update({ where: { id: found.id }, data: { multipartPartChecksums: parts } });
    });
    const authority = await options.authority.authorize(command.fence);
    const grants = await Promise.all(command.parts.map(async part => ({ partNumber: part.partNumber,
      ...wireGrant(await options.storage.signPart(assignment(record), { ...part, leaseExpiresAt: authority.leaseExpiresAt, operationDeadlineAt: authority.operationDeadlineAt })) })));
    return { disposition: "upload_parts" as const, artifactId: record.id, grants };
  }
  async function complete(command: Extract<ExecutionTransferCommand, { action: "upload-complete" }>) {
    const record = await options.authority.withAuthority(command.fence, true, async (tx, authority) => {
      const found = await row(tx, command.artifactId, authority);
      if (found.multipartAbortIntentAt || found.uploadByteLength !== BigInt(command.byteLength) || (found.checksumSha256 && found.checksumSha256 !== command.sha256)) return invalid();
      assignment(found);
      const parts = executionPartPlanSchema.parse(found.multipartPartChecksums);
      if (parts.length !== Math.ceil(command.byteLength / EXECUTION_TRANSFER_PART_BYTES) || parts.some(part => !part)) return invalid();
      return found.multipartCompleteIntentAt ? found : tx.executionArtifact.update({ where: { id: found.id }, data: { multipartCompleteIntentAt: new Date(), checksumSha256: command.sha256 } });
    });
    const upload = assignment(record);
    let target = await options.storage.head(upload);
    if (!target) {
      try {
        const inventory = await options.storage.listParts(upload);
        const parts = executionPartPlanSchema.parse(record.multipartPartChecksums);
        const receipts = inventory.map(part => {
          const frozen = parts[part.partNumber - 1];
          if (!frozen || frozen[0] !== part.byteLength || frozen[1] !== part.checksumMd5) return invalid();
          return { ...part, checksumSha256: frozen[2] };
        });
        target = await options.storage.complete(upload, receipts);
      } catch (error) {
        if (!(error instanceof ExecutionStorageError) || !["storage_completion_unconfirmed", "storage_upload_missing"].includes(error.code)) throw error;
        target = await options.storage.head(upload);
        if (!target) throw new ExecutionStorageError("storage_completion_unconfirmed");
      }
    }
    const sealed = target;
    await options.authority.withAuthority(command.fence, true, async (tx, authority) => {
      const current = await row(tx, command.artifactId, authority);
      if (current.checksumSha256 !== command.sha256 || current.uploadByteLength !== BigInt(sealed.byteLength)) return invalid();
      if (current.etag && (current.etag !== sealed.etag || current.byteLength !== BigInt(sealed.byteLength))) return invalid();
      if (!current.committedAt) await tx.executionArtifact.update({ where: { id: current.id }, data: { etag: sealed.etag, byteLength: BigInt(sealed.byteLength) } });
    });
    return { disposition: "upload_completed" as const, artifactId: record.id,
      object: { key: sealed.key, etag: sealed.etag, byteLength: sealed.byteLength, contentType: sealed.contentType, sha256: command.sha256 } };
  }
  async function workPackage(command: Extract<ExecutionTransferCommand, { action: "work-package" }>) {
    const authority = await options.authority.authorize(command.fence, false);
    const prepared = await options.resolvePackage(authority);
    if (prepared.outputs.length > 16 || prepared.sources.length > 4096) return invalid();
    const descriptors = prepared.outputs.map(value => executionOutputDescriptorSchema.parse(value));
    const outputs = await options.authority.withAuthority(command.fence, false, async (tx, live) => {
      const values = [];
      for (const descriptor of descriptors) {
        if (!contentTypes[descriptor.role]?.includes(descriptor.contentType) || (descriptor.sourceEtag === undefined) !== (descriptor.sourceByteLength === undefined)) return invalid();
        const identity = { attemptToken: live.fence.attemptToken, owner: live.fence.owner, role: descriptor.role, bindingHash: descriptor.bindingHash };
        let found = await tx.executionArtifact.findUnique({ where: { attemptToken_owner_role_bindingHash: identity } });
        if (!found) {
          const id = crypto.randomUUID();
          const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
          if (!clock) throw new ExecutorControlError("epoch_unavailable");
          found = await tx.executionArtifact.create({ data: { ...identity, id, storageKey: `execution/${live.fence.reference.deploymentEpoch}/${live.fence.attemptToken}/${live.fence.owner}/${id}`,
            contentType: descriptor.contentType, maxBytes: BigInt(descriptor.maxBytes), sourceEtag: descriptor.sourceEtag ?? null,
            sourceByteLength: descriptor.sourceByteLength === undefined ? null : BigInt(descriptor.sourceByteLength), createdAt: clock.now, grantExpiresAt: new Date(clock.now.getTime() + 1000) } });
        }
        if (found.maxBytes !== BigInt(descriptor.maxBytes) || found.sourceEtag !== (descriptor.sourceEtag ?? null) || found.sourceByteLength !== (descriptor.sourceByteLength === undefined ? null : BigInt(descriptor.sourceByteLength))) return invalid();
        values.push({ ...descriptor, artifactId: found.id, contentTypes: [...contentTypes[descriptor.role]!] });
      }
      return values;
    });
    const input = prepared.input.kind === "inline" ? prepared.input : await (async () => {
      if (!authority.input) throw new ExecutorControlError("storage_unavailable");
      const frozen = { storageKey: authority.input.storageKey, etag: authority.input.etag, byteLength: Number(authority.input.byteLength) };
      return { kind: "object" as const, ...frozen, sha256: authority.input.sha256, ...wireGrant(await options.storage.signInput(frozen, authority)) };
    })();
    const sources = await Promise.all(prepared.sources.slice(0, 16).map(async source => ({ ...source, ...wireGrant(await options.storage.signSource(source, authority)) })));
    return executionTransferDispositionSchema.parse({ disposition: "work_package", functionName: executionMediaFunctionSchema.parse(authority.functionName), inputHash: authority.fence.reference.inputHash, input, sources, outputs });
  }
  async function execute(input: { command: unknown; verifiedRequest: VerifiedExecutionRequest }): Promise<ExecutionTransferDisposition> {
    const command = executionTransferCommandSchema.parse(input.command), verified = input.verifiedRequest;
    if (!["executor-control", "dev-device"].includes(verified.metadata.audience)) throw new ExecutorControlError("invalid_audience");
    const replay = await readReceipt(verified);
    if (replay) return replay;
    const recorded = await begin(verified, command);
    if (recorded) return recorded;
    let result: ExecutionTransferDisposition;
    if (command.action === "work-package") result = await workPackage(command);
    else if (command.action === "source-read") {
      const authority = await options.authority.authorize(command.fence);
      const prepared = await options.resolvePackage(authority);
      const source = prepared.sources.find(value => value.name === command.sourceId);
      if (!source) return invalid();
      const { name: _name, ...object } = source;
      result = { disposition: "source_read", sourceId: command.sourceId, object, grant: wireGrant(await options.storage.signSource(source, authority)) };
    } else if (command.action === "upload-initialize") result = await initialize(command);
    else if (command.action === "upload-parts") result = await uploadParts(command);
    else if (command.action === "upload-complete") result = await complete(command);
    else if (command.action === "source-range") {
      const found = await plan(command), authority = await options.authority.authorize(command.fence);
      if (!options.resolvePinSource || found.committedAt || found.multipartCompleteIntentAt || found.multipartAbortIntentAt) return invalid();
      const frozen = await options.resolvePinSource(found, authority);
      if (frozen.etag !== found.sourceEtag || BigInt(frozen.byteLength) !== found.sourceByteLength) return invalid();
      const start = (command.partNumber - 1) * EXECUTION_TRANSFER_PART_BYTES;
      result = { disposition: "source_range", artifactId: found.id, partNumber: command.partNumber,
        grant: wireGrant(await options.storage.signSourceRange(assignment(found), frozen, { start, end: start + partBytes(found, command.partNumber), ...authority })) };
    } else {
      const found = await options.authority.withAuthority(command.fence, true, async (tx, authority) => {
        const current = await row(tx, command.artifactId, authority);
        if (current.committedAt || current.multipartCompleteIntentAt) throw new ExecutionStorageError("storage_completion_unconfirmed");
        return current.multipartAbortIntentAt ? current : tx.executionArtifact.update({ where: { id: current.id }, data: { multipartAbortIntentAt: new Date() } });
      });
      if (found.multipartUploadId) await options.storage.abort(assignment(found));
      result = { disposition: "upload_aborted", artifactId: found.id };
    }
    return finish(verified, command, result);
  }
  return { execute };
}
