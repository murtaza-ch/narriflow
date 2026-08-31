ALTER TABLE "GeneratedMediaJob"
  DROP CONSTRAINT "GeneratedMediaJob_duration_check",
  ADD CONSTRAINT "GeneratedMediaJob_duration_check"
  CHECK (
    ("kind" = 'image' AND "durationSec" IS NULL)
    OR (
      "kind" = 'video'
      AND "durationSec" IS NOT NULL
      AND "durationSec" > 0
    )
  ),
  DROP CONSTRAINT "GeneratedMediaJob_insertion_audit_check",
  ADD CONSTRAINT "GeneratedMediaJob_insertion_audit_check"
  CHECK (
    ("insertionCount" = 0 AND "lastInsertionKind" IS NULL AND "lastInsertedAt" IS NULL)
    OR (
      "insertionCount" > 0
      AND "lastInsertionKind" IS NOT NULL
      AND "lastInsertionKind" IN ('broll', 'scene_block')
      AND "lastInsertedAt" IS NOT NULL
    )
  );

ALTER TABLE "SocialPost"
  ADD COLUMN "thumbnailFingerprint" TEXT;

ALTER TABLE "SocialPost"
  ADD CONSTRAINT "SocialPost_thumbnail_evidence_check"
  CHECK (
    ("thumbnailAssetId" IS NULL AND "thumbnailFingerprint" IS NULL)
    OR (
      "thumbnailAssetId" IS NOT NULL
      AND "thumbnailFingerprint" IS NOT NULL
      AND "thumbnailFingerprint" ~ '^[0-9a-f]{64}$'
    )
  );
