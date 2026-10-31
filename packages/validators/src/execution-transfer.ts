import { z } from "zod";
import { executorFenceSchema, executionArtifactRoleSchema, executionMediaFunctionSchema, executionObjectIdentitySchema } from "./execution";

export const EXECUTION_TRANSFER_PART_BYTES = 16 * 1024 * 1024;
export const EXECUTION_TRANSFER_MAX_PARTS = 640;
const byteLength = z.number().int().positive().safe().max(10 * 1024 ** 3);
const mime = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const base64Digest = (bytes: number) => z.string().refine(value => {
  try { return atob(value).length === bytes && btoa(atob(value)) === value; } catch { return false; }
}, "Invalid canonical digest");
const md5 = base64Digest(16), sha256 = base64Digest(32);
const partNumber = z.number().int().min(1).max(EXECUTION_TRANSFER_MAX_PARTS);
const artifact = { fence: executorFenceSchema, artifactId: z.string().uuid() };
export const executionTransferCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("work-package"), fence: executorFenceSchema }),
  z.strictObject({ action: z.literal("source-read"), fence: executorFenceSchema, sourceId: z.string().regex(/^[a-z][a-z0-9_]{0,159}$/) }),
  z.strictObject({ action: z.literal("upload-initialize"), ...artifact, byteLength, contentType: mime }),
  z.strictObject({ action: z.literal("upload-parts"), ...artifact,
    parts: z.array(z.strictObject({ partNumber, byteLength: z.number().int().positive().max(EXECUTION_TRANSFER_PART_BYTES), checksumMd5: md5, checksumSha256: sha256 })).min(1).max(16)
      .refine(parts => new Set(parts.map(part => part.partNumber)).size === parts.length, "Duplicate part") }),
  z.strictObject({ action: z.literal("source-range"), ...artifact, partNumber }),
  z.strictObject({ action: z.literal("upload-complete"), ...artifact, byteLength, sha256: sha256Hex }),
  z.strictObject({ action: z.literal("upload-abort"), ...artifact }),
]);
const grant = z.strictObject({ url: z.url().max(8192).refine(value => new URL(value).protocol === "https:"), headers: z.record(z.string(), z.string().max(1024)), expiresAt: z.iso.datetime() });
export const executionOutputDescriptorSchema = z.strictObject({ role: executionArtifactRoleSchema, bindingHash: sha256Hex, maxBytes: byteLength,
  contentType: mime, sourceEtag: z.string().min(1).max(160).optional(), sourceByteLength: byteLength.optional() });
export const executionTransferDispositionSchema = z.discriminatedUnion("disposition", [
  z.strictObject({ disposition: z.literal("work_package"), functionName: executionMediaFunctionSchema, inputHash: sha256Hex,
    input: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("inline"), command: z.json().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32 * 1024, "Inline input exceeds32KiB") }),
      grant.extend({ kind: z.literal("object"), storageKey: z.string().max(1024), etag: z.string().max(160), byteLength: z.number().int().positive().max(EXECUTION_TRANSFER_PART_BYTES), sha256: sha256Hex }),
    ]),
    sources: z.array(grant.extend({ name: z.string().regex(/^[a-z][a-z0-9_]{0,159}$/), storageKey: z.string().max(1024), etag: z.string().max(160), byteLength, sha256: sha256Hex.optional() })).max(16),
    outputs: z.array(executionOutputDescriptorSchema.extend({ artifactId: z.string().uuid(), contentTypes: z.array(mime).min(1).max(16) })).max(16) }),
  z.strictObject({ disposition: z.literal("source_read"), sourceId: z.string().max(160), grant, object: z.strictObject({ storageKey: z.string().max(1024), etag: z.string().max(160), byteLength, sha256: sha256Hex.optional() }) }),
  z.strictObject({ disposition: z.literal("upload_ready"), artifactId: z.string().uuid(), uploadId: z.string().min(1).max(2048), byteLength,
    partSizeBytes: z.literal(EXECUTION_TRANSFER_PART_BYTES), partCount: partNumber }),
  z.strictObject({ disposition: z.literal("upload_parts"), artifactId: z.string().uuid(), grants: z.array(grant.extend({ partNumber })).min(1).max(16) }),
  z.strictObject({ disposition: z.literal("source_range"), artifactId: z.string().uuid(), partNumber, grant }),
  z.strictObject({ disposition: z.literal("upload_completed"), artifactId: z.string().uuid(), object: executionObjectIdentitySchema.extend({ contentType: mime }) }),
  z.strictObject({ disposition: z.literal("upload_aborted"), artifactId: z.string().uuid() }),
]);
export const executionPartPlanSchema = z.array(z.tuple([z.number().int().positive().max(EXECUTION_TRANSFER_PART_BYTES), md5, sha256]).nullable()).max(EXECUTION_TRANSFER_MAX_PARTS);
export type ExecutionTransferCommand = z.infer<typeof executionTransferCommandSchema>;
export type ExecutionTransferDisposition = z.infer<typeof executionTransferDispositionSchema>;
export type ExecutionOutputDescriptor = z.infer<typeof executionOutputDescriptorSchema>;
export type ExecutionPartPlan = z.infer<typeof executionPartPlanSchema>;
