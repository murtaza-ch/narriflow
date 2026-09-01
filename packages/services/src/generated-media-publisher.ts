import { createHash } from "node:crypto";
import { brandOwnerStoragePrefix, type BrandActorScope } from "./brand-ownership";
import type { GeneratedMediaAsset, GeneratedMediaPublisher } from "./generated-media";

type GeneratedImageContentType = "image/png" | "image/jpeg" | "image/webp";

export interface GeneratedMediaPublicationStorage {
  download(url: string, maxBytes: number): Promise<Uint8Array>;
  readAttempt?(key: string, maxBytes: number): Promise<Uint8Array>;
  putAttempt(key: string, bytes: Uint8Array, contentType: GeneratedImageContentType): Promise<void>;
  publishAttempt(attemptKey: string, finalKey: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface GeneratedMediaAssetRepository {
  findByFingerprint(scope: BrandActorScope, fingerprint: string): Promise<GeneratedMediaAsset | null>;
  create(input: {
    scope: BrandActorScope;
    title: string;
    storageKey: string;
    contentType: GeneratedImageContentType;
    sizeBytes: number;
    width: number;
    height: number;
    fingerprint: string;
    cleanupClaimId: string;
  }): Promise<GeneratedMediaAsset>;
  admitOrphan(storageKey: string): Promise<string>;
}

export class GeneratedMediaPublicationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GeneratedMediaPublicationError";
  }
}

function extension(contentType: GeneratedImageContentType) {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}

export function createGeneratedMediaPublisher(dependencies: {
  storage: GeneratedMediaPublicationStorage;
  repository: GeneratedMediaAssetRepository;
  inspect(bytes: Uint8Array): Promise<{
    contentType: GeneratedImageContentType;
    width: number;
    height: number;
  }>;
  maxBytes?: number;
}): GeneratedMediaPublisher {
  const maxBytes = dependencies.maxBytes ?? 20 * 1024 * 1024;

  return {
    async publish({ jobId, attempt, scope, title, result, resultContentType }) {
      const fileExtension = extension(resultContentType);
      const attemptKey = `workspaces/${scope.workspaceId}/generated-media-attempts/${jobId}/${attempt}.${fileExtension}`;
      if (result && result.contentType !== resultContentType) {
        throw new GeneratedMediaPublicationError("generated_media_output_mime_mismatch");
      }
      if (result && (result.bytes ? 1 : 0) + (result.url ? 1 : 0) !== 1) {
        throw new GeneratedMediaPublicationError("generated_media_output_malformed");
      }
      const bytes = result
        ? result.bytes ?? await dependencies.storage.download(result.url!, maxBytes)
        : await dependencies.storage.readAttempt?.(attemptKey, maxBytes).catch(() => undefined);
      if (!bytes) {
        throw new GeneratedMediaPublicationError("generated_media_attempt_unavailable");
      }
      if (bytes.byteLength === 0) {
        throw new GeneratedMediaPublicationError("generated_media_output_empty");
      }
      if (bytes.byteLength > maxBytes) {
        throw new GeneratedMediaPublicationError("generated_media_output_too_large");
      }
      const inspection = await dependencies.inspect(bytes).catch(() => null);
      if (!inspection || inspection.width <= 0 || inspection.height <= 0) {
        throw new GeneratedMediaPublicationError("generated_media_output_invalid");
      }
      if (inspection.contentType !== resultContentType) {
        throw new GeneratedMediaPublicationError("generated_media_output_mime_mismatch");
      }

      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      const existing = await dependencies.repository.findByFingerprint(scope, fingerprint);
      if (existing) {
        await dependencies.storage.delete(attemptKey).catch(() => {});
        return { ...existing, replayed: true };
      }

      const finalKey = `${brandOwnerStoragePrefix(scope, "visual-assets")}generated/${fingerprint}.${fileExtension}`;
      if (result) await dependencies.storage.putAttempt(attemptKey, bytes, resultContentType);
      let completed = false;
      try {
        // Cleanup intent must be durable before the remote side effect. The
        // asset transaction adopts this obligation on success.
        const cleanupClaimId = await dependencies.repository.admitOrphan(finalKey);
        await dependencies.storage.publishAttempt(attemptKey, finalKey);
        const asset = await dependencies.repository.create({
          scope,
          title,
          storageKey: finalKey,
          contentType: resultContentType,
          sizeBytes: bytes.byteLength,
          width: inspection.width,
          height: inspection.height,
          fingerprint,
          cleanupClaimId,
        });
        completed = true;
        return asset;
      } finally {
        if (completed) await dependencies.storage.delete(attemptKey).catch(() => {});
      }
    },
  };
}
