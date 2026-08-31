BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Workspace" AS workspace
    WHERE workspace."personalOwnerUserId" IS NOT NULL
      AND workspace."ownerUserId" <> workspace."personalOwnerUserId"
  ) THEN
    RAISE EXCEPTION 'stable_personal_brand_ownership_workspace_identity_conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Workspace" AS workspace
    JOIN "User" AS app_user
      ON app_user.id = workspace."personalOwnerUserId"
    WHERE workspace."defaultBrandProfileId" IS NOT NULL
      AND app_user."defaultBrandProfileId" IS NOT NULL
      AND workspace."defaultBrandProfileId" <> app_user."defaultBrandProfileId"
  ) THEN
    RAISE EXCEPTION 'stable_personal_brand_ownership_default_conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Workspace" AS workspace
    JOIN "BrandProfile" AS profile
      ON profile.id = workspace."defaultBrandProfileId"
    WHERE workspace."personalOwnerUserId" IS NOT NULL
      AND NOT (
        (
          profile."userId" = workspace."personalOwnerUserId"
          AND profile."workspaceId" IS NULL
        )
        OR (
          profile."userId" IS NULL
          AND profile."workspaceId" = workspace.id
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM "Workspace" AS workspace
    JOIN "User" AS app_user
      ON app_user.id = workspace."personalOwnerUserId"
    JOIN "BrandProfile" AS profile
      ON profile.id = app_user."defaultBrandProfileId"
    WHERE NOT (
      (
        profile."userId" = app_user.id
        AND profile."workspaceId" IS NULL
      )
      OR (
        profile."userId" IS NULL
        AND profile."workspaceId" = workspace.id
      )
    )
  ) THEN
    RAISE EXCEPTION 'stable_personal_brand_ownership_default_owner_conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "BrandProfile" AS moving_profile
    JOIN "Workspace" AS workspace
      ON workspace.id = moving_profile."workspaceId"
    JOIN "BrandProfile" AS existing_profile
      ON existing_profile."userId" = workspace."personalOwnerUserId"
      AND existing_profile.slug = moving_profile.slug
      AND existing_profile.id <> moving_profile.id
    WHERE workspace."personalOwnerUserId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'stable_personal_brand_ownership_profile_slug_conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "VisualAsset" AS moving_asset
    JOIN "Workspace" AS workspace
      ON workspace.id = moving_asset."workspaceId"
    JOIN "VisualAsset" AS existing_asset
      ON existing_asset."userId" = workspace."personalOwnerUserId"
      AND existing_asset.fingerprint = moving_asset.fingerprint
      AND existing_asset.id <> moving_asset.id
      AND existing_asset.provenance <> 'extracted'
    WHERE workspace."personalOwnerUserId" IS NOT NULL
      AND moving_asset.provenance <> 'extracted'
  ) THEN
    RAISE EXCEPTION 'stable_personal_brand_ownership_visual_asset_fingerprint_conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "BrandFont" AS moving_font
    JOIN "Workspace" AS workspace
      ON workspace.id = moving_font."workspaceId"
    JOIN "BrandFont" AS existing_font
      ON existing_font."userId" = workspace."personalOwnerUserId"
      AND existing_font.fingerprint = moving_font.fingerprint
      AND existing_font.id <> moving_font.id
    WHERE workspace."personalOwnerUserId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'stable_personal_brand_ownership_font_fingerprint_conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "GeneratedMediaJob" AS job
    JOIN "Workspace" AS workspace
      ON workspace.id = job."workspaceId"
    WHERE workspace."personalOwnerUserId" IS NOT NULL
      AND NOT (
        (
          job."ownerUserId" = workspace."personalOwnerUserId"
          AND job."ownerWorkspaceId" IS NULL
        )
        OR (
          job."ownerUserId" IS NULL
          AND job."ownerWorkspaceId" = workspace.id
        )
      )
  ) THEN
    RAISE EXCEPTION 'stable_personal_brand_ownership_generated_job_conflict';
  END IF;
END
$$;

UPDATE "BrandProfile" AS profile
SET
  "userId" = workspace."personalOwnerUserId",
  "workspaceId" = NULL
FROM "Workspace" AS workspace
WHERE profile."workspaceId" = workspace.id
  AND workspace."personalOwnerUserId" IS NOT NULL;

UPDATE "VisualAsset" AS asset
SET
  "userId" = workspace."personalOwnerUserId",
  "workspaceId" = NULL
FROM "Workspace" AS workspace
WHERE asset."workspaceId" = workspace.id
  AND workspace."personalOwnerUserId" IS NOT NULL;

UPDATE "BrandFont" AS font
SET
  "userId" = workspace."personalOwnerUserId",
  "workspaceId" = NULL
FROM "Workspace" AS workspace
WHERE font."workspaceId" = workspace.id
  AND workspace."personalOwnerUserId" IS NOT NULL;

UPDATE "GeneratedMediaJob" AS job
SET
  "ownerUserId" = workspace."personalOwnerUserId",
  "ownerWorkspaceId" = NULL
FROM "Workspace" AS workspace
WHERE job."workspaceId" = workspace.id
  AND job."ownerWorkspaceId" = workspace.id
  AND workspace."personalOwnerUserId" IS NOT NULL;

UPDATE "User" AS app_user
SET "defaultBrandProfileId" = workspace."defaultBrandProfileId"
FROM "Workspace" AS workspace
WHERE workspace."personalOwnerUserId" = app_user.id
  AND workspace."defaultBrandProfileId" IS NOT NULL;

UPDATE "Workspace"
SET "defaultBrandProfileId" = NULL
WHERE "personalOwnerUserId" IS NOT NULL
  AND "defaultBrandProfileId" IS NOT NULL;

ALTER TABLE "Workspace"
  ADD CONSTRAINT "Workspace_personal_owner_identity_check" CHECK (
    "personalOwnerUserId" IS NULL
    OR "personalOwnerUserId" = "ownerUserId"
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "BrandProfile" AS profile
    JOIN "Workspace" AS workspace ON workspace.id = profile."workspaceId"
    WHERE workspace."personalOwnerUserId" IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM "VisualAsset" AS asset
    JOIN "Workspace" AS workspace ON workspace.id = asset."workspaceId"
    WHERE workspace."personalOwnerUserId" IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM "BrandFont" AS font
    JOIN "Workspace" AS workspace ON workspace.id = font."workspaceId"
    WHERE workspace."personalOwnerUserId" IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM "GeneratedMediaJob" AS job
    JOIN "Workspace" AS workspace ON workspace.id = job."workspaceId"
    WHERE workspace."personalOwnerUserId" IS NOT NULL
      AND (
        job."ownerUserId" <> workspace."personalOwnerUserId"
        OR job."ownerWorkspaceId" IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM "Workspace" AS workspace
    WHERE workspace."personalOwnerUserId" IS NOT NULL
      AND workspace."defaultBrandProfileId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'stable_personal_brand_ownership_repair_incomplete';
  END IF;
END
$$;

COMMIT;
