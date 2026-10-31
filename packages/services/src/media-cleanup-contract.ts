// Stored obligations are parsed against these lists, so every producer's
// origin and class must appear here before it admits work.
export const MEDIA_CLEANUP_ORIGINS = [
  "clip_editor_document_persistence",
  "detected_clip_replacement",
  "clip_duplicate_compensation",
  "generated_media_publication",
  "thumbnail_frame_preparation",
  "upload_source_pinning",
  "upload_session_termination",
  "clip_preparation_input",
  "selection_execution",
  "publication_execution",
  "assigned_execution_artifact",
  "outbound_delivery",
] as const;
export type MediaCleanupOrigin = (typeof MEDIA_CLEANUP_ORIGINS)[number];

export const MEDIA_CLEANUP_CLASSES = [
  "mutable_render",
  "preview_proxy",
  "preview_peaks",
  "dub_media",
  "generated_asset",
  "thumbnail_asset",
  "upload_source",
  "execution_input",
  "publication_private",
  "assigned_artifact",
  "notification_body",
] as const;
export type MediaCleanupClass = (typeof MEDIA_CLEANUP_CLASSES)[number];

export interface MediaCleanupObligationInput {
  origin: MediaCleanupOrigin;
  cleanupClass: MediaCleanupClass;
  projectId?: string | null;
  clipId?: string | null;
  objectKey: string;
  /** Earliest deletion time, for keys an outstanding grant could still write. */
  notBefore?: Date;
}

export interface MediaCleanupAdmissionStore {
  createMany(input: {
    data: Array<{
      origin: MediaCleanupOrigin;
      cleanupClass: MediaCleanupClass;
      projectId: string | null;
      clipId: string | null;
      objectKey: string;
      nextAttemptAt?: Date;
      claimId?: string;
      claimExpiresAt?: Date;
    }>;
    skipDuplicates: true;
  }): Promise<{ count: number }>;
}

export interface MediaCleanupAdmissionOptions {
  heldClaim?: {
    claimId: string;
    claimExpiresAt: Date;
  };
}

