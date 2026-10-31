import type { PrismaClient } from "@prisma/client";
import { nativeValidationEvidenceSchema, nativeValidationInputSchema } from "@narriflow/validators/native-validation";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import { NativeValidationError, type NativeValidationCommit } from "./native-validation";

/** Read by the root work-package factory between live-authority checks.
 * Paths and upload URLs are supplied only by that factory/native scratch owner. */
export async function nativeValidationWorkInput(database: PrismaClient, id: string) {
  const job = await database.nativeValidationJob.findUnique({ where: { id } });
  if (!job || !job.attemptToken || job.status !== "processing") throw new NativeValidationError("native_validation_missing");
  const input = nativeValidationInputSchema.parse(job.input);
  return {
    functionName: "asset_validation" as const, inputHash: job.inputHash,
    command: { kind: input.kind, expected: { contentType: input.contentType, byteLength: Number(job.inputByteLength), sha256: input.fingerprint } },
    source: { storageKey: job.inputStorageKey, etag: job.inputEtag, byteLength: job.inputByteLength, sha256: input.fingerprint },
    outputs: [
      { role: input.kind === "font" ? "validated_font" as const : "validated_asset" as const, contentType: input.contentType, maxBytes: job.inputByteLength, bindingHash: job.inputHash },
      { role: "probe" as const, contentType: "application/json", maxBytes: 65536n, bindingHash: job.inputHash },
    ],
  };
}

/** The root storage adapter reads only this exact assigned key, capped64KiB.
 * Native metadata is sealed in storage rather than trusted from a callback. */
export async function prepareNativeValidationArtifact(artifact: ExecutorArtifactCommit, readJson: (key: string, maxBytes: number) => Promise<unknown>): Promise<NativeValidationCommit> {
  if (artifact.role === "probe") {
    if (artifact.contentType !== "application/json" || artifact.byteLength > 65536n) throw new NativeValidationError("native_validation_object_invalid");
    return { ...artifact, evidence: nativeValidationEvidenceSchema.parse(await readJson(artifact.storageKey, 65536)) };
  }
  if (artifact.role !== "validated_font" && artifact.role !== "validated_asset") throw new NativeValidationError("native_validation_object_invalid");
  return artifact;
}
