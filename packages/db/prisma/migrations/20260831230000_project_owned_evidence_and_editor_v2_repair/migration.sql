BEGIN;

LOCK TABLE
  "Clip",
  "VisualAsset",
  "ThumbnailExtractionJob",
  "ReviewRoundItem",
  "ReviewApprovalOverride",
  "ReviewNotification"
  IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Clip"
    WHERE (
      "sceneBlocks" IS NOT NULL
      AND jsonb_typeof("sceneBlocks") IS DISTINCT FROM 'array'
    ) OR (
      "censorSegments" IS NOT NULL
      AND jsonb_typeof("censorSegments") IS DISTINCT FROM 'array'
    ) OR (
      "mediaMotions" IS NOT NULL
      AND jsonb_typeof("mediaMotions") IS DISTINCT FROM 'array'
    )
  ) THEN
    RAISE EXCEPTION 'editor_document_v2_array_repair_conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "VisualAsset"
    WHERE (
      provenance = 'extracted'
      AND (
        "sourceExportVariantId" IS NULL
        OR "sourceTimeMs" IS NULL
        OR "sourceTimeMs" < 0
      )
    ) OR (
      provenance <> 'extracted'
      AND (
        "sourceExportVariantId" IS NOT NULL
        OR "sourceTimeMs" IS NOT NULL
      )
    )
  ) THEN
    RAISE EXCEPTION 'visual_asset_provenance_source_identity_conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ReviewNotification"
    WHERE status NOT IN ('pending', 'claimed', 'sent', 'failed')
      OR "attemptCount" < 0
      OR NOT (
        (
          status = 'claimed'
          AND "claimId" IS NOT NULL
          AND "leaseExpiresAt" IS NOT NULL
        )
        OR (
          status <> 'claimed'
          AND "claimId" IS NULL
          AND "leaseExpiresAt" IS NULL
        )
      )
      OR NOT (
        (
          status = 'sent'
          AND "sentAt" IS NOT NULL
          AND "failureCode" IS NULL
        )
        OR (
          status <> 'sent'
          AND "sentAt" IS NULL
        )
      )
      OR (
        status = 'failed'
        AND ("failureCode" IS NULL OR "attemptCount" = 0)
      )
  ) THEN
    RAISE EXCEPTION 'review_notification_lifecycle_conflict';
  END IF;
END
$$;

UPDATE "Clip"
SET
  "sceneBlocks" = COALESCE("sceneBlocks", '[]'::jsonb),
  "censorSegments" = COALESCE("censorSegments", '[]'::jsonb),
  "mediaMotions" = COALESCE("mediaMotions", '[]'::jsonb)
WHERE "sceneBlocks" IS NULL
  OR "censorSegments" IS NULL
  OR "mediaMotions" IS NULL;

ALTER TABLE "Clip"
  ALTER COLUMN "sceneBlocks" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "sceneBlocks" SET NOT NULL,
  ALTER COLUMN "censorSegments" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "censorSegments" SET NOT NULL,
  ALTER COLUMN "mediaMotions" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "mediaMotions" SET NOT NULL;

ALTER TABLE "VisualAsset"
  DROP CONSTRAINT "VisualAsset_sourceExportVariantId_fkey",
  DROP CONSTRAINT "VisualAsset_source_export_identity_check",
  ADD CONSTRAINT "VisualAsset_source_export_identity_check" CHECK (
    (
      provenance = 'extracted'
      AND "sourceExportVariantId" IS NOT NULL
      AND "sourceTimeMs" IS NOT NULL
      AND "sourceTimeMs" >= 0
    )
    OR (
      provenance IN ('uploaded', 'generated')
      AND "sourceExportVariantId" IS NULL
      AND "sourceTimeMs" IS NULL
    )
  );

ALTER TABLE "ThumbnailExtractionJob"
  DROP CONSTRAINT "ThumbnailExtractionJob_exportVariantId_fkey",
  ADD CONSTRAINT "ThumbnailExtractionJob_exportVariantId_fkey"
  FOREIGN KEY ("exportVariantId") REFERENCES "ClipExportVariant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewRoundItem"
  DROP CONSTRAINT "ReviewRoundItem_clipId_fkey",
  DROP CONSTRAINT "ReviewRoundItem_exportId_fkey",
  ADD CONSTRAINT "ReviewRoundItem_clipId_fkey"
  FOREIGN KEY ("clipId") REFERENCES "Clip"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReviewRoundItem_exportId_fkey"
  FOREIGN KEY ("exportId") REFERENCES "ClipExport"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewApprovalOverride"
  DROP CONSTRAINT "ReviewApprovalOverride_workspaceId_fkey",
  DROP CONSTRAINT "ReviewApprovalOverride_projectId_fkey",
  ADD CONSTRAINT "ReviewApprovalOverride_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReviewApprovalOverride_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewNotification"
  ADD CONSTRAINT "ReviewNotification_status_check" CHECK (
    status IN ('pending', 'claimed', 'sent', 'failed')
  ),
  ADD CONSTRAINT "ReviewNotification_attempt_count_check" CHECK (
    "attemptCount" >= 0
  ),
  ADD CONSTRAINT "ReviewNotification_claim_check" CHECK (
    (
      status = 'claimed'
      AND "claimId" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL
    )
    OR (
      status <> 'claimed'
      AND "claimId" IS NULL
      AND "leaseExpiresAt" IS NULL
    )
  ),
  ADD CONSTRAINT "ReviewNotification_terminal_check" CHECK (
    (
      status = 'sent'
      AND "sentAt" IS NOT NULL
      AND "failureCode" IS NULL
    )
    OR (
      status <> 'sent'
      AND "sentAt" IS NULL
      AND (
        status <> 'failed'
        OR ("failureCode" IS NOT NULL AND "attemptCount" > 0)
      )
    )
  );

COMMIT;
